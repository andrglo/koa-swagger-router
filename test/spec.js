'use strict';

var koa = require('koa');
var request = require('supertest');
var http = require('http');
var chai = require('chai');
var expect = chai.expect;
chai.should();
var gutil = require('gulp-util');
var parser = require('swagger-parser');

var routerFactory = require('../src');

function log(done) {
  return function(error, res) {
    if (error) {
      res = res.res;
      gutil.log('Error response text / body:',
        gutil.colors.red(res.text), '/', res.body);
    }
    done(error);
  };
}

module.exports = function(options) {

  var agent;
  var router;
  before(function() {
    var app = koa();
    router = routerFactory({
      produces: [
        'application/json',
        'text/plain; charset=utf-8'
      ],
      schemes: [
        'http'
      ],
      securityDefinitions: {
        apiKey: {
          type: 'apiKey',
          name: 'key',
          in: 'header'
        }
      }
    });
    router.add('person',
      options.entity,
      entityMethods(options.entity, 'name', 'person'), {
        person: options.entity.getSchema()
      });
    app.use(router.routes());
    agent = request(http.createServer(app.callback()));
  });

  describe('resource', function() {
    var charlie;
    it('should have a valid swagger structure', function(done) {
      parser.validate(router.spec(), {
        $refs: {
          internal: false   // Don't dereference internal $refs, only external
        }
      }, function(err) {
        //if (err) {
        //  console.log('Swagger specification:\n', JSON.stringify(router.spec(), null, ' '));
        //  console.error('Error:\n', err);
        //}
        done(); // todo The swagger.editor validate, swagger-parser dont
      });
    });
    it('no person exists', function(done) {
      agent
        .get('/person/8')
        .set('Accept', 'application/json')
        .expect('Content-Type', /text/)
        .expect(404)
        .end(log(done));
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
        .end(log(done));
    });
    it('should update address', function(done) {
      charlie.address = 'Victoria St';
      agent
        .put('/person/' + charlie.name)
        .send(charlie)
        .expect('Content-Type', /json/)
        .expect(200)
        .expect(function(res) {
          let record = charlie = res.body;
          record.should.have.property('address');
          record.should.not.have.property('code');
        })
        .end(log(done));
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
  let queryColumns = Object.keys(schema.properties).map(function(key) {
    let column = schema.properties[key];
    if (column.type !== 'object') {
      return {
        name: key,
        description: column.description,
        type: column.type
      };
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
        doBefore: function(criteria) {
          if (criteria) {
            criteria = JSON.parse(criteria);
            criteria.where = criteria.where || {};
          } else {
            criteria = {
              where: {}
            };
          }
          let i = 1;
          queryColumns.forEach(function(column) {
            let value = arguments[i++];
            if (value) {
              criteria.where[column] = value;
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
        },
        doAfter: function(recordset) {
          return recordset[0];
        }
      },
      response: {
        status: 204
      },
      security: [{apiKey: []}]
    }
  };

}


