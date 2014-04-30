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
  this.loadRaw(hash, function (err, buffer) {
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
  this.saveRaw(hash, buffer, function (err) {
    if (err) return callback(err);
    callback(null, hash);
  });
}

function loadRaw(hash, callback) {
  if (!callback) return loadRaw.bind(this, hash);
  var repo = this;
  var path = pathJoin(repo.rootPath, "objects", hash.substring(0, 2), hash.substring(2));
  readBinary(path, function (err, buffer) {
    if (err) return callback(err);
    if (buffer) return callback(null, buffer);
    return loadRawPacked(repo, hash, callback);
  });
}

function loadRawPacked(repo, hash, callback) {
  var packDir = pathJoin(repo.rootPath, "objects/pack");
  console.log("Looking for packdir", packDir);
  var packHashes = [];
  readDir(packDir, function (err, entries) {
    if (!entries) return callback(err);
    entries.forEach(function (name) {
      var match = name.match(/pack-([0-9a-f]{40}).idx/);
      if (match) packHashes.push(match[1]);
    });
    start();
  });
  function start() {
    var hash = packHashes.pop();
    if (!hash) return callback();
    var indexFile = pathJoin(packDir, "pack-" + hash + ".idx" );
    var packFile = pathJoin(packDir, "pack-" + hash + ".pack" );
    readBinary(indexFile, function (err, buffer) {
      if (!buffer) return callback(err);
      if (buffer[0] !== 0xff ||
          buffer[1] !== 0x74 ||
          buffer[2] !== 0x4f ||
          buffer[3] !== 0x63) {
        return callback(new Error("Only v2 pack indexes supported"));
      }
      console.log({
        index: indexFile,
        pack: packFile,
        buffer: buffer
      });
      // TODO: Implement more
    });
  }
}

function saveRaw(hash, binary, callback) {
  if (!callback) return saveRaw.bind(this, hash, binary);
  var path = pathJoin(this.rootPath, "objects", hash.substring(0, 2), hash.substring(2));
  writeBinary(path, buffer, callback);
}

function readRef(ref, callback) {
  if (!callback) return readRef.bind(this, ref);
  var repo = this;
  var path = pathJoin(repo.rootPath, ref);
  readText(path, function (err, text) {
    if (err) return callback(err);
    if (text === undefined) {
      return readPackedRef(repo, ref, callback);
    }
    callback(null, text.trim());
  });
}

function readPackedRef(repo, ref, callback) {
  var path = pathJoin(repo.rootPath, "packed-refs");
  readText(path, function (err, text) {
    if (text === undefined) return callback(err);
    var index = text.indexOf(ref);
    if (index >= 0) {
      return callback(null, text.substring(index - 41, index - 1));
    }
    callback();
  });
}

function updateRef(ref, hash, callback) {
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
    if (err.name === "NotFoundError") return callback();
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

function readDir(path, callback) {
  callback = oneshot(callback);
  get(path, "getDirectory", {}, function (err, dir) {
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

function writeBinary(path, buffer, callback) {
  var truncated = false;

  get(path, "getFile", {create:true}, onFile);

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