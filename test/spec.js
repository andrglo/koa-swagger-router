'use strict';

var koa = require('koa');
var request = require('supertest');
var http = require('http');
var chai = require('chai');
var expect = chai.expect;
chai.should();
var gutil = require('gulp-util');
var parser = require('swagger-parser');
var parseBody = require('co-body');

var RouterFactory = require('../src');

function logError(done) {
  return function(error, res) {
    if (error) {
      res = res.res;
      gutil.log('Error response text / body:',
        gutil.colors.red(res.text), '/', res.body);
    }
    done(error);
  };
}

var log = function(name, obj) {
  console.log(name);
  console.dir(obj, {
    showHidden: true,
    depth: null,
    colors: true
  });
};

module.exports = function(options) {

  var agent;
  var router;
  before(function() {
    var app = koa();
    router = new RouterFactory();
    router.spec.addDefinition('other', {
      myProperty: 'invalid swagger',
      properties: {
        name: {
          type: 'array',
          items: {
            type: 'string',
            description: 'none'
          }
        },
        otherProperty: {
          type: 'object',
          format: 'none',
          properties: {
            name: {
              type: 'string'
            }
          }
        }
      }
    });
    addStandardEntityMethods(router, 'person', options.entity);
    app.use(router.routes());
    agent = request(http.createServer(app.callback()));
  });

  describe('resource', function() {
    var charlie;
    it('should have a valid swagger structure', function(done) {
      parser.validate(router.spec.get(), {
        $refs: {
          internal: false   // Don't dereference internal $refs, only external
        }
      }, function(err) {
        if (err) {
          //gutil.log('Swagger specification:\n', JSON.stringify(router.spec.get(), null, '  '));
          //gutil.log('Error:\n', gutil.colors.red(err));
        }
        done(/*err*/); // todo The swagger.editor validate, swagger-parser don't
      });
    });
    it('no person exists', function(done) {
      agent
        .get('/person/8')
        .set('Accept', 'application/json')
        .expect('Content-Type', /text/)
        .expect(404)
        .end(logError(done));
    });
    it('should create a new person', function(done) {
      let now = (new Date()).toISOString();
      agent
        .post('/person')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Charlie'
        })
        .expect('Content-Type', /json/)
        .expect(201)
        .expect(function(res) {
          let record = charlie = res.body;
          record.should.have.property('name');
          record.should.have.property('createdAt');
          record.should.have.property('updatedAt');
          record.createdAt.should.equal(record.updatedAt);
          expect(record.createdAt).to.be.a('string');
          expect(record.createdAt).to.above(now);
        })
        .end(logError(done));
    });
    it('should update address', function(done) {
      charlie.address = 'Victoria St';
      agent
        .put('/person/' + charlie.name)
        .send(charlie)
        .expect(200)
        .expect('Content-Type', /json/)
        .expect(function(res) {
          let record = charlie = res.body;
          record.should.have.property('address');
          record.should.not.have.property('code');
        })
        .end(logError(done));
    });
    it('read charlie', function(done) {
      agent
        .get('/person?name=Charlie')
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .expect(function(res) {
          let recordset = res.body;
          expect(recordset).to.be.a('array');
          expect(recordset.length).to.equal(1);
          let record = recordset[0];
          record.should.have.property('address');
          record.should.not.have.property('code');
        })
        .end(logError(done));
    });
    it('delete charlie', function(done) {
      agent
        .delete('/person/Charlie')
        .send(charlie)
        .set('Accept', 'application/json')
        .expect(204)
        .end(logError(done));
    });
  });

};

function entityMethods(entity, id, schemaName) {

  function buildCriteria(key, updatedAt) {
    let criteria = {where: {}};
    criteria.where[id] = key;
    if (updatedAt !== void 0) {
      criteria.where.updatedAt = updatedAt;
    }
    return criteria;
  }

  let schema = entity.getSchema();
  let queryColumns = [];
  Object.keys(schema.properties).map(function(key) {
    let column = schema.properties[key];
    if (column.type !== 'object' && column.type !== 'array') {
      queryColumns.push({
        name: key,
        description: column.description,
        type: column.type
      });
    }
  });

  return {

    get: {
      operation: {
        name: 'fetch',
        params: [
          {
            name: 'criteria',
            description: 'Filter, order and or pagination to apply',
            type: 'string'
          }
        ].concat(queryColumns),
        doBefore: function(query) {
          let criteria = query.criteria;
          if (criteria) {
            criteria = JSON.parse(criteria);
            criteria.where = criteria.where || {};
          } else {
            criteria = {
              where: {}
            };
          }
          queryColumns.forEach(function(column) {
            let value = query[column.name];
            if (value) {
              criteria.where[column.name] = value;
            }
          });
          return [criteria];
        }
      },
      response: {
        type: 'array',
        schema: schemaName
      },
      security: [{apiKey: []}]
    },
    post: {
      operation: {
        name: 'create',
        params: [
          {
            name: 'body',
            description: `${schemaName} to be added`,
            required: true,
            schema: schemaName
          }
        ]
      },
      response: {
        status: 201,
        schema: schemaName
      },
      security: [{apiKey: []}]
    },
    [`get :${id}`]: {
      operation: {
        name: 'fetch',
        params: [
          {
            name: `path.${id}`,
            description: 'Object id'
          }
        ],
        doBefore: function(id) {
          return [buildCriteria(id)];
        },
        doAfter: function(recordset) {
          return recordset.length ? recordset[0] : void 0;
        }
      },
      response: {
        type: 'object',
        schema: schemaName
      },
      security: [{apiKey: []}]
    },
    [`put :${id}`]: {
      operation: {
        name: 'update',
        params: [
          {
            name: `${id}`,
            description: 'Object id'
          },
          {
            name: 'body',
            description: `${schemaName} to be updated`,
            required: true,
            schema: schemaName
          }
        ],
        doBefore: function(id, body) {
          return [body, buildCriteria(id, body.updatedAt)];
        }
      },
      response: {
        type: 'array',
        schema: schemaName
      },
      security: [{apiKey: []}]
    },
    [`delete :${id}`]: {
      operation: {
        name: 'destroy',
        params: [
          {
            name: `path.${id}`,
            description: 'Object id'
          },
          {
            name: 'body.updatedAt',
            description: 'Last update timestamp',
            required: true,
            schema: {
              type: 'object',
              properties: {
                updatedAt: {
                  type: 'string',
                  format: 'date-time'
                }
              }
            }
          }
        ],
        doBefore: function(id, updatedAt) {
          return [buildCriteria(id, updatedAt)];
        }
      },
      response: {
        status: 204
      },
      security: [{apiKey: []}]
    },
    [`delete :${id}/:none/:abc`]: {
      operation: {
        name: 'destroy',
        params: [
          {
            name: `path.${id}`,
            description: 'Object id'
          },
          {
            name: 'path.none',
            description: 'Object name'
          },
          {
            name: 'path.abc',
            description: 'Object abc'
          },
          {
            name: 'body'
          }
        ]
      },
      response: {
        status: 204
      },
      security: [{apiKey: []}]
    }
  };

}

function addStandardEntityMethods(router, name, entity) {

  function buildCriteria(key, updatedAt) {
    let criteria = {where: {}};
    criteria.where[id] = key;
    if (updatedAt !== void 0) {
      criteria.where.updatedAt = updatedAt;
    }
    return criteria;
  }

  let schema = entity.schema.get();
  router.spec.addDefinition(name, schema);

  let queryColumns = [];
  Object.keys(schema.properties).map(function(key) {
    let column = schema.properties[key];
    if (column.type !== 'object' && column.type !== 'array') {
      queryColumns.push({
        name: key,
        description: column.description,
        type: column.type
      });
    }
  });

  router
    .get(`/${name}`, function*() {
      let criteria = this.query.criteria;
      if (criteria) {
        criteria = JSON.parse(criteria);
        criteria.where = criteria.where || {};
      } else {
        criteria = {
          where: {}
        };
      }
      queryColumns.forEach(column => {
        let value = this.query[column.name];
        if (value) {
          criteria.where[column.name] = value;
        }
      });
      this.body = yield entity.fetch(criteria);
    })
    .params([{
      name: 'criteria',
      description: 'Filter, order and or pagination to apply'
    }].concat(queryColumns))
    .onSuccess({
      type: 'array',
      schema: name
    });

  var primaryKey = entity.schema.primaryKey()[0];
  router
    .get(`/${name}/:${primaryKey}`, function*() {
      let recordset = yield entity.fetch(buildCriteria(this.params[entity.primaryKey]));
      this.body = recordset.length ? recordset[0] : void 0;
    })
    .params([{
      name: 'criteria',
      description: 'Filter, order and or pagination to apply',
      type: 'string'
    }].concat(queryColumns))
    .onSuccess({
      type: 'array',
      schema: name
    });

  router
    .post(`/${name}`, function*() {
      let body = yield parseBody(this);
      this.body = yield entity.create(body);
      this.status = 201;
    })
    .params({
      in: 'body',
      name: 'body',
      description: `${name} to be added`,
      required: true,
      schema: name
    })
    .onSuccess({
      type: 'object',
      schema: name
    }, 201);

  router
    .put(`/${name}/:${primaryKey}`, function*() {
      let body = yield parseBody(this);
      let id = this.params[entity.primaryKey];
      this.body = yield entity.update(body, buildCriteria(id, body.updatedAt));
    })
    .params([{
      in: 'path',
      name: primaryKey,
      description: 'Object id'
    }, {
      name: 'body',
      description: `${primaryKey} to be updated`,
      required: true,
      schema: name
    }])
    .onSuccess({
      type: 'array',
      schema: name
    });

  router
    .delete(`/${name}/:${primaryKey}`, function*() {
      let body = yield parseBody(this);
      let id = this.params[primaryKey];
      this.body = yield entity.destroy(buildCriteria(id, body.updatedAt));
    })
    .params([{
      in: 'path',
      name: primaryKey,
      description: 'Object id',
      required: true,
      type: 'integer'
    }, {
      in: 'body',
      name: 'updatedAt',
      description: 'Last update timestamp',
      required: true,
      schema: {
        type: 'object',
        properties: {
          updatedAt: {
            type: 'string',
            format: 'date-time'
          }
        }
      }
    }])
    .onSuccess({
      description: 'Success'
    }, 204)
    .onError({
      description: 'Error'
    }, 400);
}


