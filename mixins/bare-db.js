"use strict";
var fsDb = require('js-git/mixins/fs-db');
var pathJoin = require('pathjoin');

var fileSystem = window.chrome.fileSystem;
module.exports = function (repo, entry) {
  if (repo.initChain) repo.initChain.push(init);
  else repo.initChain = [init];
  function init(callback) {
    fileSystem.restoreEntry(entry, function (result) {
      if (result) {
        var rootPath = repo.rootPath = pathJoin(result.fullPath);
        entryCache[rootPath] = result;
        return callback();
      }
      callback(new Error("Can't restore entry: " + entry));
    });
  }

  fsDb(repo, {
    readFile: readFile,
    readChunk: readChunk,
    readDir: readDir,
    writeFile: writeFile
  });

};

var entryCache = {};

function getEntry(path, method, options, callback) {
  var entry = entryCache[path];
  if (entry) return callback(null, entry);
  if (!path) return callback();
  callback = oneshot(callback);
  getDir(dirname(path), onParent);

  function onParent(err, parent) {
    if (!parent) return callback(err);
    var base = basename(path);
    parent[method](base, options, onEntry, onError);
  }

  function onEntry(entry) {
    entryCache[path] = entry;
    callback(null, entry);
  }

  function onError(err) {
    if (err.name === "NotFoundError") return callback();
    console.error(path, err);
    callback(new Error("Problem getting entry: " + path));
  }
}

function getDir(path, callback) {
  getEntry(path, "getDirectory", {create:true}, callback);
}

function getFile(path, callback) {
  getEntry(path, "getFile", {}, callback);
}

function readChunk(path, start, end, callback) {
  callback = oneshot(callback);
  getFile(path, function (err, entry) {
    if (!entry) return callback(err);
    var reader = new FileReader();
    reader.onloadend = function () {
      callback(null, new Uint8Array(this.result));
    };
    entry.file(function (file) {
      reader.readAsArrayBuffer(file.slice(start, end));
    });
  });
}

function read(path, formatter, callback) {
  getFile(path, function (err, entry) {
    if (entry === undefined) return callback(err);
    var reader = new FileReader();
    reader.onloadend = function() {
      callback(null, this.result);
    };
    entry.file(function (file) {
      reader[formatter](file);
    });
  });
}

function readFile(path, callback) {
  read(path, "readAsArrayBuffer", function (err, buffer) {
    if (!buffer) return callback(err);
    callback(null, new Uint8Array(buffer));
  });
}

function readDir(path, callback) {
  callback = oneshot(callback);
  getEntry(path, "getDirectory", {}, function (err, dir) {
    if (!dir) return callback(err);
    var entries = [];
    var dirReader = dir.createReader();
    dirReader.readEntries(onEntries, onError);
    function onEntries(results) {
      if (!results.length) return callback(null, entries);
      for (var i = 0, l = results.length; i < l; i++) {
        var entry = results[i];
        entryCache[pathJoin(path, entry.name)] = entry;
        entries.push(entry.name);
      }
      dirReader.readEntries(onEntries, onError);
    }
  });

  function onError(err) {
    if (err.name === "NotFoundError") return callback();
    console.error(path, err);
    callback(new Error("Problem reading directory: " + path));
  }
}

function writeFile(path, buffer, callback) {
  var truncated = false;

  getEntry(path, "getFile", {create:true}, onFile);

  function onFile(err, file) {
    if (!file) return callback(err);
    file.createWriter(onWriter, onError);
  }

  function onError(err) {
    console.error(err);
    // return callback(new Error("Problem writing file: " + path));
  }

  // Setup the writer and start the write
  function onWriter(fileWriter) {
    fileWriter.onwriteend = onWriteEnd;
    fileWriter.onerror = onError;
    fileWriter.write(new Blob([buffer]));
  }

  // This gets called twice.  The first calls truncate and then comes back.
  function onWriteEnd() {
    if (truncated) {
      return callback();
    }
    truncated = true;
    // Trim any extra data leftover from a previous version of the file.
    this.truncate(this.position);
  }

}

function dirname(path) {
  return path.substring(0, path.lastIndexOf("/"));
}

function basename(path) {
  return path.substring(path.lastIndexOf("/") + 1);
}

function oneshot(callback) {
  var done = false;
  return function () {
    if (done) return;
    done = true;
    return callback.apply(this, arguments);
  };
}
