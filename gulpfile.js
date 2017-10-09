var path = require('path');
var gulp = require('gulp');
var eslint = require('gulp-eslint');
var mocha = require('gulp-mocha');
var nsp = require('gulp-nsp');

gulp.task('static', function() {
  return gulp.src('src/**/*.js')
    .pipe(eslint())
    .pipe(eslint.format())
    .pipe(eslint.failAfterError());
});

gulp.task('nsp', function(cb) {
  nsp({package: path.join(__dirname, 'package.json')}, cb);
});

gulp.task('test', function(cb) {
  var error;
  gulp.src('test/index.js')
    .pipe(mocha({reporter: 'spec', bail: true, timeout: 15000}))
    .on('error', function(e) {
      error = e;
      cb(error);
    })
    .on('end', function() {
      if (!error) cb();
    });
});

gulp.task('prepublish', ['nsp']);
gulp.task('default', ['static', 'test']);
