/**
 * pads-parser.js
 *
 * Plain-JavaScript build of the PADS Layout Parser (no TypeScript, no Node.js,
 * no dependencies). Runs directly in any web browser via a <script> tag, and
 * also works in Node.js / other CommonJS environments if available.
 *
 *   Browser:  load via a script tag (src="pads-parser.js")  ->  window.PADS
 *   Node.js:  const PADS = require('./pads-parser.js');
 *
 * Supports two PADS ASCII flavors, auto-detected from the file header:
 *
 *  1. Netlist files (PADS Logic / netlist export)
 *     Header: *PADS-PCB* or *PADS2000*
 *     Sections: *PART*, *NET*, *SIGNAL*, *END*
 *
 *  2. Layout design files (PADS Layout / PowerPCB "File > Export" ASCII)
 *     Header: !PADS-POWERPCB-Vx.x-UNITS! or *PADS-LAYOUT-...*
 *     Parses the *PART* placement section (ref des, part type, decal,
 *     X, Y, rotation, board side) and pin connections from *SIGNAL* blocks.
 *
 * Differences from the original TypeScript library (deliberate):
 *  - Name-length limits produce warnings instead of hard errors, and names
 *    are never truncated (truncating silently corrupts data).
 *  - Inline "//" comments after data are stripped (the original only skipped
 *    whole-line comments).
 *  - Pin lists split on any whitespace (tabs / multiple spaces are fine).
 *  - Windows line endings (\r\n) are handled.
 *  - Each part additionally carries partType / decal / x / y / rotation /
 *    side fields, plus export helpers for spreadsheet workflows.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory(); // Node.js / CommonJS
  } else {
    root.PADS = factory(); // Browser global
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Error codes                                                         */
  /* ------------------------------------------------------------------ */

  var ErrorCodes = {
    // General file errors (E0xx)
    FILE_NOT_FOUND: { code: "E001", message: "File not found." },
    FILE_READ_ERROR: { code: "E002", message: "Error reading file." },
    INVALID_FILE_HEADER: {
      code: "E003",
      message:
        "Invalid file header. Expected '*PADS-PCB*', '*PADS2000*' or '!PADS-POWERPCB-...'.",
    },
    UNEXPECTED_EOF: { code: "E004", message: "Unexpected end of file." },

    // Section errors (E1xx)
    MISSING_PART_SECTION: { code: "E101", message: "Missing '*PART*' section." },
    MISSING_NET_SECTION: { code: "E102", message: "Missing '*NET*' section." },
    INVALID_SECTION_HEADER: {
      code: "E103",
      message: "Invalid section header. Expected '*PART*' or '*NET*'.",
    },
    UNEXPECTED_SECTION: { code: "E104", message: "Unexpected section found." },

    // Part errors (E2xx)
    INVALID_PART_FORMAT: {
      code: "E201",
      message: "Invalid part format. Expected 'RefDes Footprint [Value]'.",
    },
    DUPLICATE_PART: {
      code: "E202",
      message: "Duplicate part reference designator found.",
    },
    PART_REFDES_TOO_LONG: {
      code: "E203",
      message: "Part reference designator exceeds maximum length.",
    },
    INVALID_PART_REFDES: {
      code: "E204",
      message: "Part reference designator contains invalid characters.",
    },
    FOOTPRINT_NAME_TOO_LONG: {
      code: "E205",
      message: "Footprint name exceeds maximum length.",
    },

    // Net errors (E3xx)
    INVALID_NET_FORMAT: {
      code: "E301",
      message: "Invalid net format. Expected '*SIGNAL* NetName'.",
    },
    EMPTY_NET_NAME: { code: "E302", message: "Net name cannot be empty" },
    DUPLICATE_NET_NAME: { code: "E303", message: "Duplicate net name found." },
    NET_NAME_TOO_LONG: {
      code: "E304",
      message: "Net name exceeds maximum length.",
    },
    INVALID_NET_NAME: {
      code: "E305",
      message: "Net name contains invalid characters.",
    },

    // Pin errors (E4xx)
    INVALID_PIN_FORMAT: {
      code: "E401",
      message: "Invalid pin format. Expected 'RefDes.Pin'.",
    },
    DUPLICATE_PIN: {
      code: "E402",
      message: "Duplicate pin connection found in net.",
    },
    PIN_REFDES_TOO_LONG: {
      code: "E403",
      message: "Pin reference designator exceeds maximum length.",
    },
    PIN_NAME_TOO_LONG: {
      code: "E404",
      message: "Pin name exceeds maximum length.",
    },

    // Other errors (E5xx)
    UNEXPECTED_TOKEN: { code: "E501", message: "Unexpected token found." },
    MISSING_TOKEN: { code: "E502", message: "Expected token is missing." },
  };

  /* ------------------------------------------------------------------ */
  /* ParserError                                                         */
  /* ------------------------------------------------------------------ */

  function ParserError(errorInfo, line) {
    var err = Error.call(this, errorInfo.message + " (line " + line + ")");
    this.message = err.message;
    this.stack = err.stack;
    this.name = "ParserError";
    this.code = errorInfo.code;
    this.line = line;
  }
  ParserError.prototype = Object.create(Error.prototype);
  ParserError.prototype.constructor = ParserError;

  /* ------------------------------------------------------------------ */
  /* Constants / helpers                                                 */
  /* ------------------------------------------------------------------ */

  // Advisory limits (produce warnings, not errors — see file header note).
  var MAX_REF_DES_SIZE = 15;
  var MAX_NET_NAME_SIZE = 47;
  var MAX_FOOTPRINT_SIZE = 40;

  var PIN_TOKEN_RE = /^([A-Za-z_$][\w$\-\/]*)\.([\w$\-\/#+]+)$/;

  function stripInlineComment(line) {
    var idx = line.indexOf("//");
    return idx >= 0 ? line.substring(0, idx) : line;
  }

  // Natural sort so C2 < C10 (plain string sort puts C10 first).
  function naturalCompare(a, b) {
    var re = /(\d+)|(\D+)/g;
    var ax = String(a).match(re) || [];
    var bx = String(b).match(re) || [];
    for (var i = 0; i < Math.max(ax.length, bx.length); i++) {
      if (ax[i] === undefined) return -1;
      if (bx[i] === undefined) return 1;
      var an = parseInt(ax[i], 10);
      var bn = parseInt(bx[i], 10);
      if (!isNaN(an) && !isNaN(bn)) {
        if (an !== bn) return an - bn;
      } else if (ax[i] !== bx[i]) {
        return ax[i] < bx[i] ? -1 : 1;
      }
    }
    return 0;
  }

  // Case-insensitive keyword test: PADS control statements like *PART*
  // may appear in any letter case.
  function isKeyword(line, keyword) {
    return line.substring(0, keyword.length).toUpperCase() === keyword;
  }

  function detectFormat(data) {
    var lines = String(data).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = stripInlineComment(lines[i]).trim();
      if (!line) continue;
      if (isKeyword(line, "*PADS-PCB*") || isKeyword(line, "*PADS2000*")) {
        return "netlist";
      }
      if (/^!PADS-POWERPCB/i.test(line) || /^\*PADS-LAYOUT/i.test(line)) {
        return "layout";
      }
      return "unknown";
    }
    return "unknown";
  }

  /* ------------------------------------------------------------------ */
  /* PADSParser                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {boolean} [partialParsing=false] When true, the parser never
   *   throws: errors are collected on the result's `errors` array and
   *   parsing continues on a best-effort basis.
   */
  function PADSParser(partialParsing) {
    this.partialParsing = !!partialParsing;
    this._reset();
  }

  PADSParser.prototype._reset = function () {
    this.netlist = {
      format: "unknown",
      units: null,
      parts: [],
      nets: [],
      errors: [],
      warnings: [],
    };
    this.errors = [];
    this.warnings = [];
  };

  PADSParser.prototype._fail = function (errorInfo, lineNum) {
    var err = new ParserError(errorInfo, lineNum);
    this.errors.push(err);
    if (!this.partialParsing) throw err;
  };

  PADSParser.prototype._warn = function (message, lineNum) {
    this.warnings.push({ message: message, line: lineNum });
  };

  /**
   * Parse PADS ASCII data (netlist or layout format, auto-detected).
   * Synchronous; returns the netlist object directly.
   */
  PADSParser.prototype.parseSync = function (data) {
    this._reset();
    var format = detectFormat(data);
    this.netlist.format = format;

    if (format === "layout") {
      this._parseLayout(String(data));
    } else {
      // Unknown headers go through the netlist path, which reports
      // INVALID_FILE_HEADER with a line number.
      this._parseNetlist(String(data));
    }

    this.netlist.errors = this.errors;
    this.netlist.warnings = this.warnings;
    return this.netlist;
  };

  /**
   * Async wrapper kept for API compatibility with the TypeScript library.
   * @returns {Promise<object>} resolves to the parsed netlist.
   */
  PADSParser.prototype.parse = function (data) {
    var self = this;
    return new Promise(function (resolve, reject) {
      try {
        resolve(self.parseSync(data));
      } catch (e) {
        reject(e);
      }
    });
  };

  /* ---------------------- netlist (*PADS-PCB*) ---------------------- */

  // Sections may appear in any order (*NET* before *PART* is legal) and
  // control statements are case-insensitive.
  PADSParser.prototype._parseNetlist = function (data) {
    var lines = data.split("\n");
    var section = "start"; // start | none | part | net | signal | done
    var seenPart = false;
    var seenNet = false;
    var currentNet = null;
    var lineNum = 0;

    for (var i = 0; i < lines.length; i++) {
      lineNum = i + 1;
      var line = stripInlineComment(lines[i]).replace(/\r$/, "").trim();
      if (!line) continue;

      if (section === "start") {
        if (isKeyword(line, "*PADS-PCB*") || isKeyword(line, "*PADS2000*")) {
          section = "none";
        } else {
          this._fail(ErrorCodes.INVALID_FILE_HEADER, lineNum);
          section = "none"; // partial mode: assume header and continue
          i--; // re-process this line as section content
        }
        continue;
      }
      if (section === "done") continue; // content after *END* is ignored

      // Control statements
      if (line.charAt(0) === "*") {
        if (isKeyword(line, "*PART*")) {
          this._pushNet(currentNet);
          currentNet = null;
          section = "part";
          seenPart = true;
        } else if (isKeyword(line, "*NET*")) {
          section = "net";
          seenNet = true;
        } else if (isKeyword(line, "*SIGNAL*")) {
          if (section !== "net" && section !== "signal") {
            this._fail(ErrorCodes.INVALID_SECTION_HEADER, lineNum);
            seenNet = true; // partial mode: treat as implicit *NET*
          }
          this._pushNet(currentNet);
          currentNet = this._parseSignalHeader(line, lineNum);
          section = "signal";
        } else if (isKeyword(line, "*END*")) {
          this._pushNet(currentNet);
          currentNet = null;
          section = "done";
          if (!seenPart) this._fail(ErrorCodes.MISSING_PART_SECTION, lineNum);
          if (!seenNet) this._fail(ErrorCodes.MISSING_NET_SECTION, lineNum);
        } else if (section === "net" || section === "signal") {
          this._fail(ErrorCodes.INVALID_NET_FORMAT, lineNum);
        } else {
          this._fail(ErrorCodes.INVALID_SECTION_HEADER, lineNum);
        }
        continue;
      }

      // Data lines
      if (section === "part") {
        this._parsePartLine(line, lineNum);
      } else if (section === "signal") {
        this._parseNetPins(line, currentNet, lineNum);
      } else if (section === "net") {
        this._fail(ErrorCodes.INVALID_NET_FORMAT, lineNum);
      } else {
        // Data before any section header
        this._fail(ErrorCodes.MISSING_PART_SECTION, lineNum);
      }
    }

    if (section !== "done") {
      this._pushNet(currentNet);
      this._fail(ErrorCodes.UNEXPECTED_EOF, lineNum);
    }
  };

  PADSParser.prototype._pushNet = function (net) {
    if (net && net.pins.length > 0) this.netlist.nets.push(net);
  };

  PADSParser.prototype._parseSignalHeader = function (line, lineNum) {
    var fields = line.substring("*SIGNAL*".length).trim().split(/\s+/);
    var netName = fields[0] || "";

    if (!netName) {
      this._fail(ErrorCodes.EMPTY_NET_NAME, lineNum);
      return null;
    }
    if (fields.length > 1) {
      // Netlist signal headers carry only the net name; extra tokens mean
      // the name had whitespace in it (e.g. "*SIGNAL* NET 1").
      this._fail(ErrorCodes.INVALID_NET_NAME, lineNum);
    }
    for (var i = 0; i < this.netlist.nets.length; i++) {
      if (this.netlist.nets[i].name === netName) {
        this._fail(ErrorCodes.DUPLICATE_NET_NAME, lineNum);
        return null; // partial mode: drop the duplicate block
      }
    }
    if (netName.length > MAX_NET_NAME_SIZE) {
      this._warn(
        'Net name "' + netName + '" exceeds ' + MAX_NET_NAME_SIZE + " characters",
        lineNum
      );
    }
    return { name: netName, pins: [] };
  };

  PADSParser.prototype._parsePartLine = function (line, lineNum) {
    var tokens = line.split(/\s+/);
    var refdes = tokens.shift();
    var remaining = tokens.join(" ");

    if (!refdes || !remaining) {
      this._fail(ErrorCodes.INVALID_PART_FORMAT, lineNum);
      return;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(refdes)) {
      this._fail(ErrorCodes.INVALID_PART_REFDES, lineNum);
      return;
    }
    if (refdes.length > MAX_REF_DES_SIZE) {
      this._warn(
        'Part refdes "' + refdes + '" exceeds ' + MAX_REF_DES_SIZE + " characters",
        lineNum
      );
    }
    for (var i = 0; i < this.netlist.parts.length; i++) {
      if (this.netlist.parts[i].refdes.toLowerCase() === refdes.toLowerCase()) {
        this._fail(ErrorCodes.DUPLICATE_PART, lineNum);
        return;
      }
    }

    // "value@footprint": the last @-separated field is the footprint.
    var footprint, value;
    var at = remaining.split("@");
    if (at.length > 1) {
      footprint = at.pop().trim();
      value = at.join("@").trim();
    } else {
      footprint = remaining.trim();
    }

    if (!/^[A-Za-z0-9_.\-]+$/.test(footprint)) {
      this._fail(ErrorCodes.INVALID_PART_FORMAT, lineNum);
      return;
    }
    if (footprint.length > MAX_FOOTPRINT_SIZE) {
      this._warn(
        'Footprint "' + footprint + '" exceeds ' + MAX_FOOTPRINT_SIZE + " characters",
        lineNum
      );
    }

    this.netlist.parts.push({
      refdes: refdes,
      footprint: footprint,
      value: value || undefined,
      // Normalized fields shared with the layout format:
      partType: value || footprint,
      decal: footprint,
      side: null,
      x: null,
      y: null,
      rotation: null,
    });
  };

  PADSParser.prototype._parseNetPins = function (line, currentNet, lineNum) {
    if (!currentNet) return; // signal header was rejected in partial mode
    var pins = line.split(/\s+/);
    for (var i = 0; i < pins.length; i++) {
      var token = pins[i];
      if (!token) continue;
      var dot = token.lastIndexOf(".");
      var refdes = dot >= 0 ? token.substring(0, dot) : "";
      var pin = dot >= 0 ? token.substring(dot + 1) : "";

      if (!refdes || !pin || refdes.indexOf(".") >= 0) {
        this._fail(ErrorCodes.INVALID_PIN_FORMAT, lineNum);
        continue;
      }
      if (refdes.length > MAX_REF_DES_SIZE) {
        this._warn(
          'Pin refdes "' + refdes + '" exceeds ' + MAX_REF_DES_SIZE + " characters",
          lineNum
        );
      }

      var duplicate = false;
      for (var j = 0; j < currentNet.pins.length; j++) {
        if (currentNet.pins[j].refdes === refdes && currentNet.pins[j].pin === pin) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) {
        this._fail(ErrorCodes.DUPLICATE_PIN, lineNum);
        continue;
      }
      currentNet.pins.push({ refdes: refdes, pin: pin });
    }
  };

  /* ------------------- layout (!PADS-POWERPCB-...) ------------------- */

  // Placement line inside *PART*:
  //   refdes  parttype@decal  x  y  rotation  glued  mirror  ...
  var LAYOUT_PART_RE = new RegExp(
    "^(\\S+)\\s+" + // refdes
      "([^@\\s]*)@(\\S+)\\s+" + // parttype@decal
      "(-?[\\d.]+)\\s+" + // x
      "(-?[\\d.]+)\\s+" + // y
      "(-?[\\d.]+)" + // rotation
      "(?:\\s+(.*))?$" // flags: glued, mirror, ...
  );

  // A part item line begins with a refdes token followed by parttype@decal.
  function isPartCandidate(line) {
    return /^[A-Za-z_][^\s@]*\s+[^\s@]*@\S/.test(line);
  }

  // A flags continuation line (when a part item wrapped right after the
  // rotation field): single-letter flags and numbers only, e.g. "N M 0 -1 0 -1 0".
  function isFlagsLine(line) {
    var tokens = line.split(/\s+/);
    if (!/^[A-Z]$/.test(tokens[0])) return false;
    for (var i = 1; i < tokens.length; i++) {
      if (!/^[A-Z]$/.test(tokens[i]) && !/^-?\d+(\.\d+)?$/.test(tokens[i])) {
        return false;
      }
    }
    return true;
  }

  PADSParser.prototype._parseLayout = function (data) {
    var lines = data.split("\n");
    var section = null;
    var currentNet = null;
    var headerSeen = false;
    this._partBuf = null; // pending (possibly wrapped) part item line
    this._lastPartNoFlags = null; // part added without its flag fields yet
    this._sawPartSection = false;
    this._unmatchedPartSample = null;
    this._ignoredPartSample = null;

    for (var i = 0; i < lines.length; i++) {
      var lineNum = i + 1;
      var raw = lines[i].replace(/\r$/, "");
      var line = raw.trim();
      if (!line) continue;

      if (!headerSeen) {
        // Version token may be numeric ("V9.5", "V2007.0") or not ("VX.2"),
        // so anchor on the known units keywords instead.
        var m = /^!PADS-POWERPCB-V.*?-(MILS|METRIC|INCHES|BASIC)\b/i.exec(line);
        if (m) {
          this.netlist.units = m[1].toUpperCase();
        }
        headerSeen = true;
        continue;
      }

      // Section / control statements
      var sec = /^\*([A-Z][A-Z0-9 _-]*)\*/i.exec(line);
      if (sec) {
        var name = sec[1].trim().toUpperCase();
        this._flushPartBuf();
        if (name === "SIGNAL") {
          this._pushNet(currentNet);
          var fields = line.replace(/^\*SIGNAL\*/i, "").trim().split(/\s+/);
          currentNet = fields[0] ? { name: fields[0], pins: [] } : null;
          section = "SIGNAL";
        } else if (name === "REMARK") {
          // comment block marker — keep current section
        } else {
          this._pushNet(currentNet);
          currentNet = null;
          section = name;
          if (name === "PART") this._sawPartSection = true;
        }
        continue;
      }

      if (section === "PART") {
        this._layoutPartLine(line, lineNum);
      } else if (section === "SIGNAL" && currentNet) {
        // Collect refdes.pin tokens; routing vertex lines (pure numbers)
        // and via/layer data won't match the pin pattern.
        var tokens = line.split(/\s+/);
        for (var t = 0; t < tokens.length; t++) {
          var pt = PIN_TOKEN_RE.exec(tokens[t]);
          if (!pt) break; // route data follows the pin on the same line
          var exists = false;
          for (var p = 0; p < currentNet.pins.length; p++) {
            if (
              currentNet.pins[p].refdes === pt[1] &&
              currentNet.pins[p].pin === pt[2]
            ) {
              exists = true;
              break;
            }
          }
          if (!exists) currentNet.pins.push({ refdes: pt[1], pin: pt[2] });
        }
      }
    }
    this._flushPartBuf();
    this._pushNet(currentNet);

    if (!this._sawPartSection) {
      this._warn(
        "No *PART* section found in this layout file — when exporting from " +
          "PADS Layout, make sure the 'Parts' section is selected in the " +
          "ASCII Output dialog",
        0
      );
    } else if (this.netlist.parts.length === 0) {
      var sample = this._unmatchedPartSample || this._ignoredPartSample;
      this._warn(
        "A *PART* section was found but no part placement lines were recognized" +
          (sample
            ? '. First unrecognized entry (line ' +
              sample.lineNum +
              '): "' +
              sample.line.substring(0, 160) +
              '"'
            : " (the section appears to be empty)"),
        sample ? sample.lineNum : 0
      );
    }
  };

  PADSParser.prototype._flushPartBuf = function () {
    if (this._partBuf && !this._unmatchedPartSample) {
      this._unmatchedPartSample = this._partBuf;
    }
    this._partBuf = null;
    this._lastPartNoFlags = null;
  };

  // Handles one data line inside *PART*. Item lines longer than PADS' output
  // width (~76 chars) wrap onto continuation lines, so an item may need to be
  // reassembled from several physical lines before it matches LAYOUT_PART_RE.
  PADSParser.prototype._layoutPartLine = function (line, lineNum) {
    var m;

    // Flags that wrapped onto their own line right after the rotation field
    // (the part was already added; only the mirror flag still matters).
    if (this._lastPartNoFlags && isFlagsLine(line)) {
      if (line.split(/\s+/).indexOf("M") >= 0) {
        this._lastPartNoFlags.side = "Bottom";
      }
      this._lastPartNoFlags = null;
      return;
    }

    if (this._partBuf) {
      var joined = this._partBuf.line + " " + line;
      m = LAYOUT_PART_RE.exec(joined);
      if (m) {
        this._addLayoutPart(m, this._partBuf.lineNum);
        this._partBuf = null;
        return;
      }
      if (isPartCandidate(line)) {
        // A new item starts; the buffered one never completed.
        if (!this._unmatchedPartSample) this._unmatchedPartSample = this._partBuf;
        this._partBuf = null;
        // fall through to process this line as a fresh item
      } else if (this._partBuf.appends < 3 && joined.length < 500) {
        this._partBuf.line = joined;
        this._partBuf.appends++;
        return;
      } else {
        if (!this._unmatchedPartSample) this._unmatchedPartSample = this._partBuf;
        this._partBuf = null;
        return;
      }
    }

    m = LAYOUT_PART_RE.exec(line);
    if (m) {
      this._addLayoutPart(m, lineNum);
    } else if (isPartCandidate(line)) {
      this._partBuf = { line: line, lineNum: lineNum, appends: 0 };
    } else if (!this._ignoredPartSample) {
      // Label sublines (coordinates, fonts, "REF-DES", ...) land here; keep
      // the first one only as a diagnostic sample for zero-part warnings.
      this._ignoredPartSample = { line: line, lineNum: lineNum };
    }
  };

  PADSParser.prototype._addLayoutPart = function (m, lineNum) {
    var refdes = m[1];
    var partType = m[2];
    var decal = m[3];
    var x = parseFloat(m[4]);
    var y = parseFloat(m[5]);
    var rotRaw = parseFloat(m[6]);
    var flags = (m[7] || "").trim().split(/\s+/);

    this._lastPartNoFlags = null;
    for (var i = 0; i < this.netlist.parts.length; i++) {
      if (this.netlist.parts[i].refdes.toLowerCase() === refdes.toLowerCase()) {
        this._fail(ErrorCodes.DUPLICATE_PART, lineNum);
        return;
      }
    }

    // Some PADS versions store rotation in tenths of a degree (e.g. 2700
    // for 270°). Values above 360 are assumed to use that encoding.
    var rotation = rotRaw > 360 ? rotRaw / 10 : rotRaw;

    // The mirror flag ('M') means the part is on the bottom side.
    var mirrored = false;
    for (var f = 0; f < flags.length; f++) {
      if (flags[f] === "M") {
        mirrored = true;
        break;
      }
    }

    var part = {
      refdes: refdes,
      footprint: decal,
      value: partType || undefined,
      partType: partType || decal,
      decal: decal,
      side: mirrored ? "Bottom" : "Top",
      x: x,
      y: y,
      rotation: rotation,
    };
    this.netlist.parts.push(part);

    // If the item wrapped immediately after the rotation field, its flags
    // (including the mirror flag) arrive on the next line — remember the
    // part so _layoutPartLine can still set its side.
    if (!m[7] || !m[7].trim()) this._lastPartNoFlags = part;
  };

  /* ------------------------------------------------------------------ */
  /* Export helpers (for spreadsheet workflows)                          */
  /* ------------------------------------------------------------------ */

  function sortedParts(netlist) {
    return netlist.parts.slice().sort(function (a, b) {
      return naturalCompare(a.refdes, b.refdes);
    });
  }

  function fmt(v) {
    return v === null || v === undefined ? "" : String(v);
  }

  function joinTable(rows, sep) {
    return rows
      .map(function (r) {
        return r
          .map(function (c) {
            c = fmt(c);
            if (sep === "," && /[",\n]/.test(c)) {
              c = '"' + c.replace(/"/g, '""') + '"';
            }
            return c;
          })
          .join(sep);
      })
      .join("\n");
  }

  /**
   * Rows shaped for a layout-parts spreadsheet:
   * Ref Des | Part Type | Decal / Footprint | Side | X | Y | Rotation
   */
  function layoutPartsTable(netlist, includeHeader) {
    var rows = [];
    if (includeHeader !== false) {
      rows.push([
        "Ref Des",
        "Part Type",
        "Decal / Footprint",
        "Side (Top/Bottom)",
        "X",
        "Y",
        "Rotation",
      ]);
    }
    sortedParts(netlist).forEach(function (p) {
      rows.push([p.refdes, p.partType, p.decal, p.side, p.x, p.y, p.rotation]);
    });
    return rows;
  }

  /**
   * Rows shaped for a schematic-parts spreadsheet: Ref Des | Part Type
   */
  function schematicPartsTable(netlist, includeHeader) {
    var rows = [];
    if (includeHeader !== false) rows.push(["Ref Des", "Part Type"]);
    sortedParts(netlist).forEach(function (p) {
      rows.push([p.refdes, p.partType]);
    });
    return rows;
  }

  function netsTable(netlist, includeHeader) {
    var rows = [];
    if (includeHeader !== false) rows.push(["Net Name", "Pin Count", "Pins"]);
    netlist.nets.forEach(function (n) {
      rows.push([
        n.name,
        n.pins.length,
        n.pins
          .map(function (p) {
            return p.refdes + "." + p.pin;
          })
          .join(" "),
      ]);
    });
    return rows;
  }

  /**
   * Groups parts by part type: counts, decals used, and whether the same
   * part type was placed with more than one decal (footprint mismatch check).
   */
  function bomSummary(netlist) {
    var map = {};
    netlist.parts.forEach(function (p) {
      var key = p.partType || "(none)";
      if (!map[key]) {
        map[key] = { partType: key, count: 0, decals: [], refdes: [] };
      }
      map[key].count++;
      map[key].refdes.push(p.refdes);
      if (map[key].decals.indexOf(p.decal) < 0) map[key].decals.push(p.decal);
    });
    return Object.keys(map)
      .sort(naturalCompare)
      .map(function (k) {
        var e = map[k];
        e.refdes.sort(naturalCompare);
        e.mixedDecals = e.decals.length > 1;
        return e;
      });
  }

  function bomSummaryTable(netlist, includeHeader) {
    var rows = [];
    if (includeHeader !== false) {
      rows.push(["Part Type", "Decal(s) Used", "# Placed", "Mixed Decals?", "Ref Des List"]);
    }
    bomSummary(netlist).forEach(function (e) {
      rows.push([
        e.partType,
        e.decals.join(", "),
        e.count,
        e.mixedDecals ? "MIXED" : "OK",
        e.refdes.join(", "),
      ]);
    });
    return rows;
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  return {
    PADSParser: PADSParser,
    ParserError: ParserError,
    ErrorCodes: ErrorCodes,
    detectFormat: detectFormat,
    naturalCompare: naturalCompare,
    bomSummary: bomSummary,

    // Table builders (arrays of rows)
    layoutPartsTable: layoutPartsTable,
    schematicPartsTable: schematicPartsTable,
    netsTable: netsTable,
    bomSummaryTable: bomSummaryTable,

    // String exports: TSV pastes straight into Excel; CSV downloads cleanly.
    toLayoutPartsTSV: function (nl) { return joinTable(layoutPartsTable(nl), "\t"); },
    toLayoutPartsCSV: function (nl) { return joinTable(layoutPartsTable(nl), ","); },
    toSchematicPartsTSV: function (nl) { return joinTable(schematicPartsTable(nl), "\t"); },
    toSchematicPartsCSV: function (nl) { return joinTable(schematicPartsTable(nl), ","); },
    toNetsCSV: function (nl) { return joinTable(netsTable(nl), ","); },
    toNetsTSV: function (nl) { return joinTable(netsTable(nl), "\t"); },
    toBomSummaryTSV: function (nl) { return joinTable(bomSummaryTable(nl), "\t"); },
    toBomSummaryCSV: function (nl) { return joinTable(bomSummaryTable(nl), ","); },
  };
});
