"use strict";
var fsDb = require('js-git/mixins/fs-db');
var chromeFs = require('../lib/chrome-fs');

module.exports = function (repo, entry) {

  // Tell git-tree to wait for this entry to resolve
  if (repo.initChain) repo.initChain.push(init);
  else repo.initChain = [init];

  // Apply the abstract mixin using our concrete fs implementation.
  fsDb(repo, chromeFs);

  function init(callback) {
    chromeFs.registerEntry(entry, function (err, rootPath) {
      if (err) return callback(err);
      repo.rootPath = rootPath;
      return callback();
    });
  }

};
