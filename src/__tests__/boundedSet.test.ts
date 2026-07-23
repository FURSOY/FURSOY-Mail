import { describe, expect, it } from "vitest";
import { addBoundedSetValue } from "../boundedSet";

describe("bounded set", () => {
  it("evicts the oldest value when the limit is exceeded", () => {
    const values = new Set(["oldest", "middle"]);
    addBoundedSetValue(values, "newest", 2);
    expect([...values]).toEqual(["middle", "newest"]);
  });

  it("refreshes an existing value without growing", () => {
    const values = new Set(["first", "second"]);
    addBoundedSetValue(values, "first", 2);
    expect([...values]).toEqual(["second", "first"]);
  });
});
