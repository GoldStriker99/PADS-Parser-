/**
 * Test harness for the plain-JavaScript parser (js/pads-parser.js).
 * Runs against the fixture files in __tests__/ plus the layout example.
 *
 * Usage: node js/run-tests.js
 *
 * Note: three "*_too_long" fixtures are expected to PASS here because the
 * JS build deliberately downgrades name-length limits to warnings (the
 * fixtures themselves are contradictory — __tests__/valid/long_names.pads
 * contains longer names than the "invalid" too-long fixtures).
 */
"use strict";

var fs = require("fs");
var path = require("path");
var PADS = require("./pads-parser.js");

var VALID_DIR = path.join(__dirname, "..", "__tests__", "valid");
var INVALID_DIR = path.join(__dirname, "..", "__tests__", "invalid");

var failures = 0;
var passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok    " + name);
  } catch (e) {
    failures++;
    console.log("  FAIL  " + name + " -> " + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function parseFile(file) {
  var data = fs.readFileSync(file, "utf8");
  return new PADS.PADSParser().parseSync(data);
}

function expectError(file, code) {
  var data = fs.readFileSync(file, "utf8");
  var threw = null;
  try {
    new PADS.PADSParser().parseSync(data);
  } catch (e) {
    threw = e;
  }
  assert(threw, "expected ParserError " + code + " but parse succeeded");
  assert(
    threw.code === code,
    "expected " + code + " but got " + threw.code + " (" + threw.message + ")"
  );
  // Partial mode must not throw for the same file:
  var nl = new PADS.PADSParser(true).parseSync(data);
  assert(nl.errors.length > 0, "partial mode should collect errors");
}

console.log("Valid netlist fixtures (must parse with zero errors):");
fs.readdirSync(VALID_DIR)
  .filter(function (f) { return f.endsWith(".pads"); })
  .forEach(function (f) {
    check(f, function () {
      var nl = parseFile(path.join(VALID_DIR, f));
      assert(nl.format === "netlist", "expected netlist format");
      assert(nl.errors.length === 0, "unexpected errors: " + JSON.stringify(nl.errors));
    });
  });

console.log("\nValid fixture contents:");
check("basic.pads parts/nets", function () {
  var nl = parseFile(path.join(VALID_DIR, "basic.pads"));
  assert(nl.parts.length === 3, "expected 3 parts, got " + nl.parts.length);
  assert(nl.nets.length === 5, "expected 5 nets, got " + nl.nets.length);
  assert(nl.parts[0].refdes === "U1" && nl.parts[0].footprint === "DIP14", "U1 DIP14");
});
check("values.pads value@footprint split", function () {
  var nl = parseFile(path.join(VALID_DIR, "values.pads"));
  var u1 = nl.parts.filter(function (p) { return p.refdes === "U1"; })[0];
  assert(u1.value === "PIC16F676" && u1.footprint === "SOIC-14", "U1 value/footprint");
  var gnd = nl.nets.filter(function (n) { return n.name === "Gnd"; })[0];
  assert(gnd.pins.length === 26, "Gnd should span the continuation line (26 pins), got " + gnd.pins.length);
});
check("comments.pads inline comments stripped", function () {
  var nl = parseFile(path.join(VALID_DIR, "comments.pads"));
  var u1 = nl.parts.filter(function (p) { return p.refdes === "U1"; })[0];
  assert(u1 && u1.footprint === "DIP14", "U1 footprint should be DIP14, got " + (u1 && u1.footprint));
});

console.log("\nInvalid netlist fixtures (strict mode must throw the right code):");
[
  ["invalid_missing_header.pads", "E003"],
  ["invalid_unexpected_eof.pads", "E004"],
  ["invalid_missing_part_section.pads", "E101"],
  ["invalid_missing_net_section.pads", "E102"],
  ["invalid_part_format.pads", "E201"],
  ["invalid_duplicate_part.pads", "E202"],
  ["invalid_part_refdes.pads", "E204"],
  ["invalid_net_format.pads", "E301"],
  ["invalid_empty_net_name.pads", "E302"],
  ["invalid_duplicate_net_name.pads", "E303"],
  ["invalid_net_name.pads", "E305"],
  ["invalid_pin_format.pads", "E401"],
  ["invalid_duplicate_pin.pads", "E402"],
].forEach(function (pair) {
  check(pair[0] + " -> " + pair[1], function () {
    expectError(path.join(INVALID_DIR, pair[0]), pair[1]);
  });
});

console.log("\nLength-limit fixtures (warnings, not errors — see header note):");
[
  "invalid_part_refdes_too_long.pads",
  "invalid_footprint_name_too_long.pads",
  "invalid_net_name_too_long.pads",
].forEach(function (f) {
  check(f + " -> parses with warnings", function () {
    var nl = parseFile(path.join(INVALID_DIR, f));
    assert(nl.errors.length === 0, "should have no errors");
    assert(nl.warnings.length > 0, "should have warnings");
  });
});

console.log("\nLayout format:");
check("layout_basic.asc parts + placement", function () {
  var nl = parseFile(path.join(__dirname, "examples", "layout_basic.asc"));
  assert(nl.format === "layout", "format should be layout");
  assert(nl.units === "MILS", "units should be MILS, got " + nl.units);
  assert(nl.parts.length === 5, "expected 5 parts, got " + nl.parts.length);

  var c1 = nl.parts.filter(function (p) { return p.refdes === "C1"; })[0];
  assert(c1.partType === "CAP100PF0402", "C1 part type");
  assert(c1.decal === "CAP0402", "C1 decal");
  assert(c1.x === 1250 && c1.y === 800, "C1 position");
  assert(c1.rotation === 90, "C1 rotation");
  assert(c1.side === "Top", "C1 side");

  var j1 = nl.parts.filter(function (p) { return p.refdes === "J1"; })[0];
  assert(j1.side === "Bottom", "J1 should be Bottom (mirrored)");

  var r1 = nl.parts.filter(function (p) { return p.refdes === "R1"; })[0];
  assert(r1.rotation === 270, "R1 rotation 2700 tenth-degrees -> 270, got " + r1.rotation);
});
check("layout_basic.asc signals + pins", function () {
  var nl = parseFile(path.join(__dirname, "examples", "layout_basic.asc"));
  assert(nl.nets.length === 3, "expected 3 nets, got " + nl.nets.length);
  var gnd = nl.nets.filter(function (n) { return n.name === "GND"; })[0];
  var pins = gnd.pins.map(function (p) { return p.refdes + "." + p.pin; }).sort();
  assert(
    JSON.stringify(pins) === JSON.stringify(["C1.2", "C2.2", "J1.1"]),
    "GND pins deduped from route data, got " + pins.join(" ")
  );
});

console.log("\nLayout wrapped lines + diagnostics:");
check("part items wrapped across lines (PADS ~76-char output width)", function () {
  var data = [
    "!PADS-POWERPCB-V9.5-MILS! DESIGN DATABASE ASCII FILE 1.0",
    "*PART*       ITEMS",
    // wrapped between coordinates:
    "U100             TPS54331DR_LONG_TYPE_NAME@SOIC127P600X170-8N     13741.42",
    "                 14947.44  270  N M 0 -1 0 -1 0",
    // wrapped right after rotation, flags on their own line:
    "C55              CAP_VERY_LONG_TYPE_NAME_100NF_X7R_16V@CAPC1005X55N 1200 3400 90",
    "N M 0 -1 0 -1 0",
    // normal single-line item:
    "R9               RES10K@RES0603 100 200 0 N N 0 -1 0 -1 0",
    "*END*",
  ].join("\n");
  var nl = new PADS.PADSParser().parseSync(data);
  assert(nl.parts.length === 3, "expected 3 parts, got " + nl.parts.length);
  var u100 = nl.parts.filter(function (p) { return p.refdes === "U100"; })[0];
  assert(u100.x === 13741.42 && u100.y === 14947.44, "U100 joined coordinates");
  assert(u100.side === "Bottom", "U100 mirrored flag from joined line");
  var c55 = nl.parts.filter(function (p) { return p.refdes === "C55"; })[0];
  assert(c55.side === "Bottom", "C55 side from flags continuation line, got " + c55.side);
  var r9 = nl.parts.filter(function (p) { return p.refdes === "R9"; })[0];
  assert(r9.side === "Top", "R9 stays Top");
});
check("missing *PART* section -> actionable warning", function () {
  var nl = new PADS.PADSParser().parseSync(
    "!PADS-POWERPCB-V9.5-MILS!\n*ROUTE*\n*SIGNAL* GND\nC1.2 C2.2\n*END*\n"
  );
  assert(nl.warnings.length === 1, "one warning expected");
  assert(/Parts' section is selected/.test(nl.warnings[0].message), "mentions export option");
});
check("unrecognized part lines -> warning quotes the line", function () {
  var nl = new PADS.PADSParser().parseSync(
    "!PADS-POWERPCB-V9.5-MILS!\n*PART*\nSOMETHING WEIRD FORMAT 123\n*END*\n"
  );
  assert(nl.parts.length === 0, "no parts");
  assert(
    /First unrecognized entry \(line 3\): "SOMETHING WEIRD FORMAT 123"/.test(nl.warnings[0].message),
    "warning should quote the offending line, got: " + nl.warnings[0].message
  );
});

console.log("\nExport helpers:");
check("toLayoutPartsTSV shape + natural sort", function () {
  var nl = parseFile(path.join(__dirname, "examples", "layout_basic.asc"));
  var lines = PADS.toLayoutPartsTSV(nl).split("\n");
  assert(lines[0].split("\t").length === 7, "7 columns");
  assert(lines[1].indexOf("C1\t") === 0, "first data row is C1");
  var nl2 = new PADS.PADSParser().parseSync(
    "*PADS-PCB*\n*PART*\nC10 A\nC2 B\n*NET*\n*SIGNAL* N1\nC10.1 C2.1\n*END*\n"
  );
  var rows = PADS.layoutPartsTable(nl2, false);
  assert(rows[0][0] === "C2" && rows[1][0] === "C10", "natural sort C2 < C10");
});
check("bomSummary flags mixed decals", function () {
  var nl = new PADS.PADSParser().parseSync(
    "*PADS-PCB*\n*PART*\nR1 10k@0603\nR2 10k@0805\n*NET*\n*SIGNAL* N1\nR1.1 R2.1\n*END*\n"
  );
  var bom = PADS.bomSummary(nl);
  assert(bom.length === 1 && bom[0].mixedDecals === true, "10k placed with 2 decals");
});

console.log("\n" + passed + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
