'use strict';

var Resource = require('koa-resource-router');
var compose = require('koa-compose');
var parse = require('co-body');
var yaml = require('js-yaml');
var fs = require('fs');
var path = require('path');

var log = console.log;

module.exports = function(spec) {

  let resources = [];
  let specs = [load(spec)];

  return {
    resource: function(name, collection, options) {
      options = options || {};
      specs.push(yaml.load(fs.readFileSync(path.join(__dirname, 'resource.yaml'))
        .toString()
        .replace(/\$model/g, name.toLowerCase())));
      resources.push(new Resource(name, actions(collection), {
        id: options.id || 'id'
      }));
    },
    use: function(api, apiSpec) {
      specs.push(load(apiSpec));
      //todo
    },
    middleware: function() {
      return compose(resources.map(function(resource) {
        return resource.middleware();
      }));
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

function actions(collection) {

  return {

    index: function*() {
      var criteria;
      if (this.query.criteria) {
        criteria = JSON.parse(this.query.criteria);
      } else {
        criteria = {
          where: this.query
        };
      }
      this.body = yield collection.query(criteria);
    },

    create: function*() {
      var body = yield parse(this);
      this.body = yield collection.create(body);
      this.status = 201;
    },

    update: function*() {
      var body = yield parse(this);
      this.body = yield collection.update(body, buildCriteria(this.params));
      if (!this.body) {
        this.throw(404);
      }
    },

    show: function*() {
      let recordset = yield collection.fetch(buildCriteria(this.params));
      if (!recordset.length) {
        this.throw(404);
      }
      this.body = recordset[0];
    },

    destroy: function*() {
      yield collection.destroy(buildCriteria(this.params));
      this.status = 204;
    }
  };
}

function buildCriteria(params) {
  let key = Object.keys(params)[0];
  let criteria = {where: {}};
  criteria.where[key] = params[key];
  return criteria;
}
