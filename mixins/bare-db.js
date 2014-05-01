var pathJoin = require('pathjoin');
var bodec = require('bodec');
var inflate = require('js-git/lib/inflate');
var deflate = require('js-git/lib/deflate');
var sha1 = require('git-sha1');
var codec = require('js-git/lib/object-codec');
var parsePackEntry = require('js-git/lib/pack-codec').parseEntry;
var applyDelta = require('js-git/lib/apply-delta');

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
  this.loadRaw(hash, function (err, raw) {
    if (raw === undefined) return callback(err);
    var body;
    try {
      if (sha1(raw) !== hash) {
        throw new TypeError("Hash verification failure");
      }
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
  var raw, hash;
  try {
    raw = codec.frame({
      type: type,
      body: codec.encoders[type](value)
    });
    hash = sha1(raw);
  }
  catch (err) { return callback(err); }
  this.saveRaw(hash, raw, function (err) {
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
    if (buffer) {
      var raw;
      try { raw = inflate(buffer); }
      catch (err) { return callback(err); }
      return callback(null, raw);
    }
    return loadRawPacked(repo, hash, callback);
  });
}

var cachedIndexes = {};
function loadRawPacked(repo, hash, callback) {
  var packDir = pathJoin(repo.rootPath, "objects/pack");
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
    var packHash = packHashes.pop();
    var offsets;
    if (!packHash) return callback();
    if (!cachedIndexes[packHash]) loadIndex(packHash);
    else onIndex();

    function loadIndex() {
      var indexFile = pathJoin(packDir, "pack-" + packHash + ".idx" );
      readBinary(indexFile, function (err, buffer) {
        if (!buffer) return callback(err);
        try {
          cachedIndexes[packHash] = parseIndex(buffer);
        }
        catch (err) { return callback(err); }
        onIndex();
      });
    }

    function onIndex() {
      var cached = cachedIndexes[packHash];
      var packFile = pathJoin(packDir, "pack-" + packHash + ".pack" );
      var index = cached.byHash[hash];
      if (!index) return start();
      offsets = cached.offsets;
      loadChunk(packFile, index.offset, callback);
    }

    function loadChunk(packFile, start, callback) {
      var index = offsets.indexOf(start);
      var end = index >= 0 ? offsets[index + 1] : -20;
      readChunk(packFile, start, end, function (err, chunk) {
        if (!chunk) return callback(err);
        var raw;
        try {
          var entry = parsePackEntry(chunk);
          if (entry.type === "ref-delta") {
            return loadRaw.call(repo, hash, onBase);
          }
          else if (entry.type === "ofs-delta") {
            return loadChunk(packFile, start - entry.ref, onBase);
          }
          raw = codec.frame(entry);
        }
        catch (err) { return callback(err); }
        callback(null, raw);

        function onBase(err, base) {
          if (!base) return callback(err);
          var object = codec.deframe(base);
          var body;
          try {
            object.body = applyDelta(entry.body, object.body);
            buffer = codec.frame(object);
          }
          catch (err) { return callback(err); }
          callback(null, buffer);
        }
      });
    }

  }
}


function saveRaw(hash, raw, callback) {
  if (!callback) return saveRaw.bind(this, hash, raw);
  var path = pathJoin(this.rootPath, "objects", hash.substring(0, 2), hash.substring(2));
  var buffer;
  try { buffer = deflate(raw); }
  catch (err) { return callback(err); }
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

function parseIndex(buffer) {
  if (readUint32(buffer, 0) !== 0xff744f63 ||
      readUint32(buffer, 4) !== 0x00000002) {
    throw new Error("Only v2 pack indexes supported");
  }

  // Get the number of hashes in index
  // This is the value of the last fan-out entry
  var hashOffset = 8 + 255 * 4;
  var length = readUint32(buffer, hashOffset);
  hashOffset += 4;
  var crcOffset = hashOffset + 20 * length;
  var lengthOffset = crcOffset + 4 * length;
  var largeOffset = lengthOffset + 4 * length;
  var checkOffset = largeOffset;
  var indexes = new Array(length);
  for (var i = 0; i < length; i++) {
    var start = hashOffset + i * 20;
    var hash = bodec.toHex(bodec.slice(buffer, start, start + 20));
    var crc = readUint32(buffer, crcOffset + i * 4);
    var offset = readUint32(buffer, lengthOffset + i * 4);
    if (offset & 0x80000000) {
      offset = largeOffset + (offset &0x7fffffff) * 8;
      checkOffset = Math.max(checkOffset, offset + 8);
      offset = readUint64(buffer, offset);
    }
    indexes[i] = {
      hash: hash,
      offset: offset,
      crc: crc
    };
  }
  var packChecksum = bodec.toHex(bodec.slice(buffer, checkOffset, checkOffset + 20));
  var checksum = bodec.toHex(bodec.slice(buffer, checkOffset + 20, checkOffset + 40));
  var hash = sha1(bodec.slice(buffer, 0, checkOffset + 20));
  if (hash !== checksum) throw new Error("Checksum mistmatch");

  var byHash = {};
  indexes.sort(function (a, b) {
    return a.offset - b.offset;
  });
  indexes.forEach(function (data, i) {
    var next = indexes[i + 1];
    byHash[data.hash] = {
      offset: data.offset,
      crc: data.crc,
    };
  });
  offsets = indexes.map(function (entry) {
    return entry.offset;
  }).sort(function (a, b) {
    return a - b;
  });

  return {
    offsets: offsets,
    byHash: byHash,
    checksum: packChecksum
  };
}


function readUint32(buffer, offset) {
  return (buffer[offset] << 24 |
          buffer[offset + 1] << 16 |
          buffer[offset + 2] << 8 |
          buffer[offset + 3] << 0) >>> 0;
}

// Yes this will lose precision over 2^53, but that can't be helped when
// returning a single integer.
// We simply won't support packfiles over 8 petabytes. I'm ok with that.
function readUint64(buffer, offset) {
  var hi = (buffer[offset] << 24 |
            buffer[offset + 1] << 16 |
            buffer[offset + 2] << 8 |
            buffer[offset + 3] << 0) >>> 0;
  var lo = (buffer[offset + 4] << 24 |
            buffer[offset + 5] << 16 |
            buffer[offset + 6] << 8 |
            buffer[offset + 7] << 0) >>> 0;
  return hi * 0x100000000 + lo;
}

function readBinaryHex(buffer, offset) {
  return bodec.toHex(buffer.slice(offset, 20));
}