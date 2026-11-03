"use strict";
const test = require("node:test");
const assert = require("node:assert");
const php = require("../lib/extractors/php");

test("stripComments keeps strings and line numbers", () => {
  const src = "a // x\n'//not' /* b\nc */ d # e\n#[Attr] f";
  const out = php.stripComments(src);
  assert.equal(out.split("\n").length, 4);
  assert.match(out, /'\/\/not'/);
  assert.match(out, /#\[Attr\] f/);
  assert.doesNotMatch(out, /x|e$/m);
});

test("splitArgs, literal, classRef, listValues", () => {
  assert.deepEqual(php.splitArgs("'a', [1, 2], fn () => f(1, 2)"), ["'a'", "[1, 2]", "fn () => f(1, 2)"]);
  assert.equal(php.literal("'it\\'s'"), "it's");
  assert.equal(php.literal('"a{$b}"'), null);
  assert.equal(php.classRef("\\App\\Foo::class"), "App\\Foo");
  assert.deepEqual(php.listValues(["['auth', Foo::class, $x]"]), { values: ["auth", "Foo"], dynamic: 1 });
});

test("chainCalls splits a fluent chain", () => {
  const c = php.chainCalls("prefix('api')->middleware(['a', 'b'])->get('x', X::class)");
  assert.deepEqual(c.map((x) => x.name), ["prefix", "middleware", "get"]);
  assert.deepEqual(c[2].args, ["'x'", "X::class"]);
});

test("staticConcat reads the middleware-parameter idiom", () => {
  assert.equal(php.staticConcat("Ensure::class.':transfers'"), "Ensure:transfers");
  assert.equal(php.staticConcat("$x.'a'"), null);
  assert.deepEqual(php.listValues(["Ensure::class.':a'"]), { values: ["Ensure:a"], dynamic: 0 });
});
