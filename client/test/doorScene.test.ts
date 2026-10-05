// The sign-in screen greets you by the hour (Ohiyo sounds like "ohayo", good morning) and
// shows the painting that matches: sunrise, morning, the meadow, sunset, night.
//   node --experimental-strip-types --test test/doorScene.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { doorScene } from "../src/lib/doorScene.ts";

test("every hour of the day has a scene, a greeting and a line", () => {
  for (let hour = 0; hour < 24; hour++) {
    const scene = doorScene(hour);
    assert.ok(scene.greeting.length > 3 && scene.line.length > 3, `hour ${hour}`);
    assert.ok(["sunrise", "morning", "day", "sunset", "night"].includes(scene.key), `hour ${hour}`);
  }
});

test("the painting follows the sun", () => {
  const keys = (hours: number[]) => [...new Set(hours.map((h) => doorScene(h).key))];
  assert.deepEqual(keys([5, 6, 7]), ["sunrise"]);
  assert.deepEqual(keys([8, 9, 10, 11]), ["morning"]);
  assert.deepEqual(keys([12, 13, 14, 15, 16]), ["day"]);
  assert.deepEqual(keys([17, 18, 19, 20]), ["sunset"]);
  assert.deepEqual(keys([21, 22, 23, 0, 1, 2, 3, 4]), ["night"]);
});

test("the greeting matches the hour", () => {
  assert.equal(doorScene(7).greeting, "Good morning.");
  assert.equal(doorScene(10).greeting, "Good morning.");
  assert.equal(doorScene(14).greeting, "Good afternoon.");
  assert.equal(doorScene(19).greeting, "Good evening.");
  assert.equal(doorScene(22).greeting, "Good evening.");
  // Nobody is wished a good morning at three at night.
  assert.equal(doorScene(3).greeting, "Still up?");
});

test("only the night scene is dark, so the words are light there and dark elsewhere", () => {
  assert.equal(doorScene(23).tone, "dark");
  assert.equal(doorScene(2).tone, "dark");
  for (const hour of [6, 10, 14, 19]) assert.equal(doorScene(hour).tone, "light", `hour ${hour}`);
});

test("a clock that makes no sense gets the daytime scene instead of a crash", () => {
  for (const odd of [-1, 24, 99, 3.5, Number.NaN]) assert.equal(doorScene(odd).key, "day", String(odd));
});
