// Brain contract package: the versioned boundary between the loop runtime
// (neutral host) and pluggable agent brains (decision modules). Brains depend
// on this package and on the capability contract — never on runtime or tool
// implementations.
export * from "./types.js";
export * from "./validate.js";
