import { afterAll } from "bun:test";
import { removeTempDirs } from "./fixtures.ts";

// A preload's afterAll runs once after every test file; exit hooks do not fire under bun test.
afterAll(() => {
  removeTempDirs();
});
