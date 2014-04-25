var pathJoin = require('pathjoin');
var inflate = require('js-git/lib/inflate');
var deflate = require('js-git/lib/deflate');
var sha1 = require('git-sha1');
var codec = require('js-git/lib/object-codec');

var fileSystem = window.chrome.fileSystem;
module.exports = function (repo, entry) {
  if (repo.initChain) repo.initChain.push(init);
  else repo.initChain = [init];
  function init(callback) {
    fileSystem.restoreEntry(entry, function (result) {
      if (result) {
        repo.rootPath = result.fullPath;
        entryCache[pathJoin(result.fullPath)] = result;
        return callback();
      }
      callback(new Error("Can't restore entry: " + entry));
    });
  }

  repo.loadAs = loadAs;
  repo.saveAs = saveAs;
  repo.loadRaw = loadRaw;
  repo.saveRaw = saveRaw;
  repo.readRef = readRef;
  repo.updateRef = updateRef;

};

function loadAs(type, hash, callback) {
  if (!callback) return loadAs.bind(this, type, hash);
  var path = pathJoin(this.rootPath, "objects", hash.substring(0, 2), hash.substring(2));
  readBinary(path, function (err, buffer) {
    if (buffer === undefined) return callback(err);
    var body;
    try {
      var raw = inflate(buffer);
      if (sha1(raw) !== hash) throw new TypeError("Hash verification failure");
      raw = codec.deframe(raw);
      if (raw.type !== type) throw new TypeError("Type mismatch");
      body = codec.decoders[raw.type](raw.body);
    }
    catch (err) { return callback(err); }
    callback(null, body);
  });
}

function saveAs(type, value, callback) {
  if (!callback) return saveAs.bind(this, type, value);
  var buffer, hash;
  try {
    var raw = codec.frame({
      type: type,
      body: codec.encoders[type](value)
    });
    hash = sha1(raw);
    buffer = deflate(raw);
  }
  catch (err) { return callback(err); }
  var path = pathJoin(this.rootPath, "objects", hash.substring(0, 2), hash.substring(2));
  writeBinary(path, buffer, function (err) {
    if (err) return callback(err);
    callback(null, hash);
  });
}

function loadRaw(hash, callback) {
  if (!callback) return loadRaw.bind(this, hash);
  callback(new Error("TODO: Implement loadRaw"));
}

function saveRaw(hash, binary, callback) {
  if (!callback) return saveRaw.bind(this, hash, binary);
  callback(new Error("TODO: Implement saveRaw"));
}

function readRef(ref, callback) {
  if (!callback) return readRef.bind(this, ref);
  var path = pathJoin(this.rootPath, ref);
  readText(path, function (err, text) {
    if (text === undefined) return callback(err);
    callback(null, text.trim());
  });
}

function updateRef(ref, hash, callback) {
  console.log("updateRef", ref, hash);
  if (!callback) return updateRef.bind(this, ref, hash);
  var path = pathJoin(this.rootPath, ref);
  writeBinary(path, hash + "\n", callback);
}


var entryCache = {};

function get(path, method, options, callback) {
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
    console.error(path, err);
    callback(new Error("Problem getting entry: " + path));
  }
}

function getDir(path, callback) {
  get(path, "getDirectory", {create:true}, callback);
}

function getFile(path, callback) {
  get(path, "getFile", {}, callback);
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
function readText(path, callback) {
  read(path, "readAsText", callback);
}
function readBinary(path, callback) {
  read(path, "readAsArrayBuffer", function (err, buffer) {
    if (!buffer) return callback(err);
    callback(null, new Uint8Array(buffer));
  });
}

function writeBinary(path, buffer, callback) {
  console.log("writeBinary", path);
  var truncated = false;

  get(path, "getFile", {create:true}, onFile);

  function onFile(err, file) {
    if (!file) return callback(err);
    console.log("onFile", path, file);
    file.createWriter(onWriter, onError);
  }

  function onError(err) {
    console.log("onError", path, err);
    console.error(err);
    // return callback(new Error("Problem writing file: " + path));
  }

  // Setup the writer and start the write
  function onWriter(fileWriter) {
    console.log("onWriter", path, fileWriter);
    fileWriter.onwriteend = onWriteEnd;
    fileWriter.onerror = onError;
    fileWriter.write(new Blob([buffer]));
  }

  // This gets called twice.  The first calls truncate and then comes back.
  function onWriteEnd() {
    console.log("onWriteEnd", path);
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