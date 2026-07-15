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
check("PADS V10 format: no @decal, label sublines, *PARTTYPE* decal lookup", function () {
  var data = [
    "!PADS-POWERPCB-V10.0-MILS-250L! DESIGN DATABASE ASCII FILE 1.0",
    "*PARTTYPE*   ITEMS",
    "",
    "0402CS           IND0402 UND 1 0 0 A",
    "G 1 2",
    "CAPX             CAP0402:CAP0402ALT UND 1 0 0 A",
    "*PART*       ITEMS",
    "",
    "*REMARK* REFNM PTYPENM X Y ORI GLUE MIRROR ALT CLSTID CLSTATTR BROTHERID LABELS",
    "L15             0402CS 6110  -2700 270.000 U M 0 -1 0 -1 3",
    "VALUE           0           0   0.000 127          35           2 N CENTER CENTER ANGLED",
    "Regular <Romansim Stroke Font>",
    "Ref.Des.",
    "NONE       -34.69      -65.71   0.000  1          45           1 N   LEFT   DOWN",
    "Regular <Romansim Stroke Font>",
    "Ref.Des.",
    "VALUE      -34.69       20.51   0.000  1          50           1 N   LEFT     UP",
    "Regular <Romansim Stroke Font>",
    "Part Type",
    "C7              CAPX 100 200 0.000 U N 0 -1 0 -1 0",
    "*END*",
  ].join("\n");
  var nl = new PADS.PADSParser().parseSync(data);
  var names = nl.parts.map(function (p) { return p.refdes; }).join(",");
  assert(nl.parts.length === 2, "expected 2 parts (labels must not become parts), got: " + names);
  var l15 = nl.parts[0];
  assert(l15.refdes === "L15" && l15.partType === "0402CS", "L15 identity");
  assert(l15.x === 6110 && l15.y === -2700 && l15.rotation === 270, "L15 placement");
  assert(l15.side === "Bottom", "L15 mirrored (U M) -> Bottom, got " + l15.side);
  assert(l15.decal === "IND0402", "L15 decal from *PARTTYPE*, got '" + l15.decal + "'");
  var c7 = nl.parts[1];
  assert(c7.side === "Top", "C7 (U N) -> Top");
  assert(c7.decal === "CAP0402", "C7 decal = first of colon list, got '" + c7.decal + "'");
  assert(nl.units === "MILS", "units from V10 header, got " + nl.units);
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

console.log("\nPADS Logic schematic format:");
var LOGIC_SAMPLE = [
  "*PADS-LOGIC-V9.0* DESIGN EXPORT FILE FROM PADS LOGIC VVX.2.15",
  "*SHT*   5 5_RX_OUTPUT1 -1 $$$NONE",
  "*PARTTYPE*   ITEMS",
  "",
  "$PWR_SYMS UND  0   0   2     0",
  "TIMESTAMP 1999.03.30.22.52.06",
  "PWR 7",
  "+5V P +5V",
  "",
  "12110305-001 BGA  6   0   0     0",
  "TIMESTAMP 2024.07.31.22.48.17",
  "GATE 1 48 0",
  "BFIC-I/O",
  "K1 0 L RFIN_0",
  "",
  "*PART*       ITEMS",
  "",
  "PD1          XBAND-RX_COMBINER 7000  11700   0 2 80 8 80 8 3 2 3 0 0 24",
  '"Default Font"',
  '"Default Font"',
  '70 240 0 0 100 10 0 "Default Font"',
  "REF-DES",
  '600 100 0 0 80 8 0 "Default Font"',
  "PART-TYPE",
  "*",
  '"Created By" P.LOFTUS',
  '"PCB DECAL" XBAND-RX_COMBINER',
  "0 -20 -80 0 1",
  "1 70 20 0 1",
  "",
  "U3-A         12110305-001     11900 10200   0 0 80 8 80 8 4 11 48 0 0 0",
  '"Default Font"',
  '"EDU Part Number" 12110305-002',
  '"Checked By" ',
  '"Manufacturer" Lockheed-Martin',
  '"PCB DECAL" AWMF-0245-BGA',
  '"SIGPINAE5" RFGND_RX',
  "$PG1         $PWR_SYMS 100 100 0 0 80 8 80 8 3 2 3 0 0 24",
  "*CONNECTION*",
  "*SIGNAL* RXBFIC_IN0 0 0",
  "PD1.3        @@@O1        3 0",
  "7400   12000",
  "7900   12200",
  "U3-A.K1      @@@D461      2 0",
  "11700  14200",
  "@@@D482      @@@D461      2 0",
  "10400  14200",
  "@@@D482      X271.1       2 0",
  "*NETNAMES*",
  'RXBFIC_IN0   @@@O1        350    10     0 0 0      0      0 2 -1 8 80 "Default Font"',
  "*SHT*   6 6_RX_OUTPUT2 -1 $$$NONE",
  "*PART*       ITEMS",
  "",
  "U3-B         12110305-001     17900 9100    0 0 80 8 80 8 4 11 41 0 0 0",
  '"PCB DECAL" AWMF-0245-BGA',
  "*CONNECTION*",
  "*SIGNAL* RXBFIC_IN0 0 0",
  "U3-B.G1      @@@O9        2 0",
  "*SIGNAL* $$$19966 64 0",
  "@@@D5        @@@D6        2 0",
].join("\n");

check("logic export: parts, gate merge, attributes, decal", function () {
  var nl = new PADS.PADSParser().parseSync(LOGIC_SAMPLE);
  assert(nl.format === "logic", "format should be logic, got " + nl.format);
  var names = nl.parts.map(function (p) { return p.refdes; }).join(",");
  assert(nl.parts.length === 2, "expected 2 parts (PD1, U3 merged; $PG1 excluded), got: " + names);
  var pd1 = nl.parts.filter(function (p) { return p.refdes === "PD1"; })[0];
  assert(pd1.decal === "XBAND-RX_COMBINER", "PD1 decal from PCB DECAL attribute");
  var u3 = nl.parts.filter(function (p) { return p.refdes === "U3"; })[0];
  assert(u3, "U3-A/U3-B should merge into U3");
  assert(u3.partType === "12110305-001", "U3 part type");
  assert(u3.gates.join(",") === "A,B", "U3 gates A,B, got " + u3.gates.join(","));
  assert(u3.sheets.join(",") === "5_RX_OUTPUT1,6_RX_OUTPUT2", "U3 sheets, got " + u3.sheets.join(","));
  assert(u3.decal === "AWMF-0245-BGA", "U3 decal from attribute");
  assert(u3.attributes["EDU Part Number"] === "12110305-002", "EDU Part Number attribute");
  assert(u3.attributes["Manufacturer"] === "Lockheed-Martin", "Manufacturer attribute");
});
check("logic export: nets merged across sheets, gate-stripped pins", function () {
  var nl = new PADS.PADSParser().parseSync(LOGIC_SAMPLE);
  assert(nl.nets.length === 1, "one net with pins (empty $$$ net dropped), got " + nl.nets.length);
  var net = nl.nets[0];
  assert(net.name === "RXBFIC_IN0", "net name");
  var pins = net.pins.map(function (p) { return p.refdes + "." + p.pin; }).sort().join(" ");
  assert(
    pins === "PD1.3 U3.G1 U3.K1 X271.1",
    "pins across both sheets, gate suffix stripped, junctions/offpage excluded; got: " + pins
  );
});
check("logic export: schematic table has attribute columns", function () {
  var nl = new PADS.PADSParser().parseSync(LOGIC_SAMPLE);
  var rows = PADS.schematicPartsTable(nl);
  var header = rows[0].join("|");
  assert(/^Ref Des\|Part Type\|PCB Decal\|Gates\|Sheet\(s\)/.test(header), "fixed columns first, got " + header);
  assert(header.indexOf("EDU Part Number") >= 0, "attribute column present");
  assert(header.indexOf("SIGPIN") < 0, "pin-level SIGPIN* attributes excluded");
  var u3row = rows.filter(function (r) { return r[0] === "U3"; })[0];
  assert(u3row[3] === 2 && u3row[2] === "AWMF-0245-BGA", "U3 gates=2 and decal in row");
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
