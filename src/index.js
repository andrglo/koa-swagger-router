'use strict';

var parse = require('co-body');
var assert = require('assert');
var yaml = require('js-yaml');
var router = require('koa-router')();
var fs = require('fs');
var path = require('path');

var log = console.log;

module.exports = function(spec) {

  let resources = [];
  spec = load(spec || './spec.yaml');

  return {

    add: function(prefix, api, methods, definitions) {

      // todo build swagger

      let keys = Object.keys(methods);
      keys.forEach(function(key) {
        let action = methods[key];
        let keyInfo = match(key, /(^\w*) ?(.*)/);
        let method = keyInfo[0].toLowerCase();
        let path = `/${prefix}`;
        if (keyInfo[1]) {
          path += `/${keyInfo[1]}`;
        }
        let params = match(path, /\:(\w*)/g);
        router[method](path, function*() {

          let args = [];
          params.forEach(function(param) {
            args.push(this.params[param]);
          }, this);
          if (method === 'get') {
            args.push(this.query);
          } else {
            let body = yield parse(this);
            args.push(body);
          }
          if (action.parameters && action.parameters.parse) {
            args = action.parameters.parse.apply(this, args);
          }
          assert(action.operationId, 'Operation not informed');
          assert(api[action.operationId], 'Operation ' + action.operationId + ' not defined');
          //todo check if it is a generator or a promise
          let promise = api[action.operationId].apply(api, args);
          let result = yield promise;
          if (action.response && action.response.parse) {
            result = action.response.parse.call(this, result);
          }
          if (result === void 0) {
            this.status = 404;
          } else {
            this.body = result;
            if (action.response && action.response.status) {
              this.status = action.response.status;
            }
          }
        });
      });
    },
    routes: function() {
      return router.routes();
    }
  };
};

function load(spec) {
  if (typeof spec === 'string') {
    let extname = path.extname(spec);
    if (extname === '.yaml' || extname === '.yml') {
      return yaml.load(fs.readFileSync(spec));
    } else if (extname === '.json' || extname === '.js') {
      return require(spec);
    } else {
      throw new Error('File "' + spec + '" is invalid');
    }
  }
  return spec;
}

function match(str, re) {
  if (!re.global) {
    return str.match(re).slice(1);
  }
  var res = [];
  var m;
  while ((m = re.exec(str)) !== null) {
    if (m.index === re.lastIndex) {
      re.lastIndex++;
    }
    res.push(m[1]);
  }
  return res;
}
