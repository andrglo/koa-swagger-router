var gutil = require('gulp-util');
var PgCrLayer = require('pg-cr-layer');
var jse = require('json-schema-entity');
var personSchema = require('./schemas/person.json');

var authDb = require('auth-db');

var spec = require('./spec');

var pgConfig = {
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD,
  database: 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: process.env.POSTGRES_PORT || 5432,
  pool: {
    max: 10,
    idleTimeout: 30000
  }
};
var pg = new PgCrLayer(pgConfig);

var databaseName = 'test-koa-swagger-router';

function createPostgresDb() {
  var dbName = process.env.POSTGRES_DATABASE || databaseName;
  return pg.execute(
      'DROP DATABASE IF EXISTS "' + dbName + '";')
    .then(function() {
      return pg.execute('CREATE DATABASE "' + dbName + '"');
    })
    .then(function() {
      return authDb.redis.flushdb();
    })
    .then(function() {
      return authDb.roles.create({
        name: 'admin',
        acl: ['/spec', '/person/*', '/person']
      }).then(() => authDb.roles.create({
        name: 'cr',
        acl: ['/spec', '/person']
      }));
    });
}

var pgOptions = {};

before(function(done) {
  return pg.connect()
    .then(function() {
      return createPostgresDb()
        .then(function() {
          gutil.log('Postgres db created');
          return pg.close();
        })
        .then(function() {
          gutil.log('Postgres db creation connection closed');
          pgConfig.database = process.env.POSTGRES_DATABASE || databaseName;
          gutil.log('Postgres will connect to', pgConfig.database);
          pgOptions.db = new PgCrLayer(pgConfig);
          return pgOptions.db.connect();
        })
        .then(function() {
          pgOptions.entity = jse('person', personSchema, {db: pgOptions.db});
          pgOptions.entity.useTimestamps();
          pgOptions.entity
            .hasMany('person as children', personSchema, {db: pgOptions.db})
            .foreignKey('fkChildren');
          pgOptions.entity
            .hasOne('person as parent', personSchema, {db: pgOptions.db})
            .foreignKey('fkParent');
          return pgOptions.entity.createTables();
        });
    })
    .then(function() {
      done();
    })
    .catch(function(error) {
      done(error);
    });
});

describe('postgres', function() {
  var duration;
  before(function() {
    duration = process.hrtime();
  });
  spec(pgOptions);
  after(function() {
    duration = process.hrtime(duration);
    gutil.log('Postgres finished');
  });
});

after(function() {
  pgOptions.db.close();
  authDb.redis.quit();
});

