#!/usr/bin/env node
'use strict';

/*
 * Launcher for @axlabs/venice-e2ee-proxy.
 *
 * IMPORTANT: keep this file written in old-Node-compatible (ES5) syntax only —
 * no nullish coalescing (??), optional chaining (?.), template literals, arrow
 * functions, const/let, etc. JavaScript parses an entire module before running
 * it, so the compiled app (dist/main.js, which targets a modern Node) would
 * throw a cryptic "SyntaxError: Unexpected token '?'" on old Node before any of
 * our code runs. This launcher checks the Node version first and prints a clear,
 * actionable message instead.
 */

var path = require('path');

var MIN_MAJOR = 20;
var versionString = process.versions.node;
var major = parseInt(versionString.split('.')[0], 10);

if (isNaN(major) || major < MIN_MAJOR) {
  process.stderr.write(
    '\n' +
      'venice-e2ee-proxy requires Node.js ' +
      MIN_MAJOR +
      ' or newer, but you are running Node ' +
      versionString +
      '.\n\n' +
      'Please upgrade Node.js: https://nodejs.org\n' +
      'With nvm:  nvm install ' +
      MIN_MAJOR +
      ' && nvm use ' +
      MIN_MAJOR +
      '\n\n',
  );
  process.exit(1);
}

require(path.join(__dirname, '..', 'dist', 'main.js'));
