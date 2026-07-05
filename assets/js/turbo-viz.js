// Interactive teaching widgets for the "fast HTML parser" post.
// Five independent widgets, each initialized from a container the shortcode
// emits: .tv-swar (the SWAR has-zero bit trick, computed with real 64-bit
// BigInt math), .tv-scan (the SIMD/SWAR block scan + two-pass escape),
// .tv-width (PEP 393 native-width storage), .tv-tok (a steppable WHATWG
// tokenizer state machine), and .tv-entity (unescape: binary search +
// longest-prefix character-reference matching). Colors live in custom.css so
// dark mode switches without JS; this file only builds DOM and toggles classes.
(function () {
  "use strict";

  var SPECIALS = {
    "&": { entity: "&amp;", grow: 4 },
    "<": { entity: "&lt;", grow: 3 },
    ">": { entity: "&gt;", grow: 3 },
    '"': { entity: "&quot;", grow: 5 },
    "'": { entity: "&#x27;", grow: 5 },
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function hex2(n) {
    return n.toString(16).toUpperCase().padStart(2, "0");
  }

  // A printable label for a byte cell: the character itself, or a caret name
  // for the few control characters the demos can produce.
  function glyph(ch) {
    if (ch === " ") return "␣";
    if (ch === "\t") return "⇥";
    if (ch === "\n") return "⏎";
    return ch;
  }

  // Build the shared header + body chrome and return the body to fill.
  function mount(root, title) {
    var head = el("div", "tv-head");
    head.appendChild(el("span", "tv-badge", "interactive"));
    head.appendChild(el("span", "tv-title", title));
    var body = el("div", "tv-body");
    root.appendChild(head);
    root.appendChild(body);
    return body;
  }

  // ---------------------------------------------------------------- SWAR

  var M64 = (1n << 64n) - 1n;
  var ONES = 0x0101010101010101n;
  var HIGHS = 0x8080808080808080n;

  function swarMask(bytes, target) {
    // Assemble eight bytes into one 64-bit word, byte 0 most significant so the
    // lanes read left to right, then run the real has-zero test on word ^ t.
    var word = 0n;
    for (var i = 0; i < 8; i++) {
      word = (word << 8n) | BigInt(bytes[i] || 0);
    }
    var x = (word ^ (ONES * BigInt(target))) & M64;
    var notx = ~x & M64;
    var mask = (x - ONES) & notx & HIGHS;
    var hits = [];
    for (var j = 0; j < 8; j++) {
      hits.push((mask >> (8n * BigInt(7 - j))) & 0x80n ? true : false);
    }
    return { word: word, xored: x, mask: mask, hits: hits };
  }

  function laneRow(label, cells) {
    var row = el("div", "tv-row");
    row.appendChild(el("span", "tv-rowlabel", label));
    var lanes = el("div", "tv-lanes");
    cells.forEach(function (c) {
      lanes.appendChild(c);
    });
    row.appendChild(lanes);
    return row;
  }

  function initSwar(root) {
    var initial = (root.dataset.text || "Tom & Jerry").slice(0, 8);
    var target = root.dataset.target || "&";
    var body = mount(root, "SWAR has-zero: one byte hunted in eight");

    var controls = el("div", "tv-controls");
    var inWrap = el("label", "tv-field");
    inWrap.appendChild(el("span", "tv-fieldlabel", "8 bytes of text"));
    var input = el("input", "tv-input tv-mono");
    input.type = "text";
    input.maxLength = 8;
    input.value = initial;
    input.spellcheck = false;
    inWrap.appendChild(input);
    controls.appendChild(inWrap);

    var selWrap = el("label", "tv-field");
    selWrap.appendChild(el("span", "tv-fieldlabel", "hunt for"));
    var select = el("select", "tv-input tv-mono");
    ["&", "<", ">", '"', "'"].forEach(function (s) {
      var opt = el("option", null, s + "  (0x" + hex2(s.charCodeAt(0)) + ")");
      opt.value = s;
      if (s === target) opt.selected = true;
      select.appendChild(opt);
    });
    selWrap.appendChild(select);
    controls.appendChild(selWrap);

    var display = el("div", "tv-display");
    body.appendChild(controls);
    body.appendChild(display);

    function render() {
      display.textContent = "";
      var text = input.value;
      var t = (select.value || "&").charCodeAt(0);
      var bytes = [];
      for (var i = 0; i < 8; i++) {
        bytes.push(i < text.length ? text.charCodeAt(i) & 0xff : 0);
      }
      var res = swarMask(bytes, t);

      // Row 1: the raw bytes.
      var byteCells = bytes.map(function (b, i) {
        var pad = i >= text.length;
        var cell = el("div", "tv-cell" + (pad ? " tv-pad" : ""));
        cell.appendChild(el("span", "tv-char", pad ? "·" : glyph(text[i])));
        cell.appendChild(el("span", "tv-hex", hex2(b)));
        return cell;
      });
      display.appendChild(laneRow("bytes", byteCells));

      // Row 2: XOR with the broadcast target; a matching lane becomes 0x00.
      var xorCells = bytes.map(function (b, i) {
        var v = b ^ t;
        var pad = i >= text.length;
        var zero = v === 0;
        var cell = el("div", "tv-cell" + (zero ? " tv-hit" : "") + (pad ? " tv-pad" : ""));
        cell.appendChild(el("span", "tv-hex", hex2(v)));
        return cell;
      });
      display.appendChild(laneRow("⊕ '" + select.value + "'", xorCells));

      // Row 3: the has-zero mask; the high bit lights up in zeroed lanes.
      var maskCells = res.hits.map(function (hit, i) {
        var pad = i >= text.length;
        var cell = el("div", "tv-cell" + (hit ? " tv-hit" : "") + (pad ? " tv-pad" : ""));
        cell.appendChild(el("span", "tv-char", hit ? "■" : "·"));
        cell.appendChild(el("span", "tv-hex", hit ? "80" : "00"));
        return cell;
      });
      display.appendChild(laneRow("has-zero", maskCells));

      var found = res.hits.filter(Boolean).length;
      var verdict = el("div", "tv-verdict " + (found ? "tv-v-dirty" : "tv-v-clean"));
      if (found) {
        verdict.textContent =
          "mask = 0x" +
          res.mask.toString(16).toUpperCase().padStart(16, "0") +
          ": '" +
          select.value +
          "' is in this word (" +
          found +
          (found === 1 ? " lane)" : " lanes)");
      } else {
        verdict.textContent = "mask = 0, no '" + select.value + "' here, the whole 8-byte block is clean";
      }
      display.appendChild(verdict);
    }

    input.addEventListener("input", render);
    select.addEventListener("change", render);
    render();
  }

  // ------------------------------------------------------------ SIMD scan

  function escapeChar(ch) {
    return SPECIALS[ch] ? SPECIALS[ch].entity : ch;
  }

  function initScan(root) {
    var initial = root.dataset.text || 'Tom & Jerry <3 "hi" don\'t';
    var block = parseInt(root.dataset.block || "16", 10);
    if (block !== 8 && block !== 16) block = 16;
    var body = mount(root, "Block scan: escaping the way the CPU sees it");

    var controls = el("div", "tv-controls");
    var inWrap = el("label", "tv-field tv-grow");
    inWrap.appendChild(el("span", "tv-fieldlabel", "text to escape"));
    var input = el("input", "tv-input tv-mono");
    input.type = "text";
    input.value = initial;
    input.spellcheck = false;
    inWrap.appendChild(input);
    controls.appendChild(inWrap);

    var toggle = el("div", "tv-toggle");
    toggle.appendChild(el("span", "tv-fieldlabel", "block size"));
    var btnRow = el("div", "tv-btnrow");
    var btns = {};
    [8, 16].forEach(function (b) {
      var btn = el("button", "tv-btn" + (b === block ? " tv-on" : ""), b + " bytes");
      btn.type = "button";
      btn.addEventListener("click", function () {
        block = b;
        btns[8].classList.toggle("tv-on", b === 8);
        btns[16].classList.toggle("tv-on", b === 16);
        render();
      });
      btns[b] = btn;
      btnRow.appendChild(btn);
    });
    toggle.appendChild(btnRow);
    controls.appendChild(toggle);

    var display = el("div", "tv-display");
    var summary = el("div", "tv-summary");
    var output = el("div", "tv-output tv-mono");
    body.appendChild(controls);
    body.appendChild(display);
    body.appendChild(summary);
    body.appendChild(output);

    function render() {
      display.textContent = "";
      var text = input.value;
      var totalSpecials = 0;
      var growth = 0;

      for (var start = 0; start < text.length || start === 0; start += block) {
        if (start >= text.length && text.length > 0) break;
        var end = Math.min(start + block, text.length);
        if (text.length === 0) {
          break;
        }
        var blockEl = el("div", "tv-block");
        var lanes = el("div", "tv-lanes");
        var specials = 0;
        for (var i = start; i < end; i++) {
          var ch = text[i];
          var sp = SPECIALS[ch];
          var cell = el("div", "tv-cell" + (sp ? " tv-special" : ""));
          cell.appendChild(el("span", "tv-char", glyph(ch)));
          cell.appendChild(el("span", "tv-hex", sp ? sp.entity : hex2(ch.charCodeAt(0) & 0xff)));
          if (sp) {
            specials++;
            growth += sp.grow;
          }
          lanes.appendChild(cell);
        }
        blockEl.appendChild(lanes);
        var n = end - start;
        var verdict = el("div", "tv-blockverdict " + (specials ? "tv-v-dirty" : "tv-v-clean"));
        verdict.textContent = specials
          ? specials + (specials === 1 ? " special → copy gaps + rewrite" : " specials → copy gaps + rewrite")
          : "clean → one memcpy of " + n + " bytes";
        blockEl.appendChild(verdict);
        display.appendChild(blockEl);
        totalSpecials += specials;
      }

      if (text.length === 0) {
        display.appendChild(el("div", "tv-empty", "type something above"));
      }

      summary.textContent =
        text.length +
        " bytes scanned · " +
        totalSpecials +
        (totalSpecials === 1 ? " special found · output grows +" : " specials found · output grows +") +
        growth;
      if (totalSpecials === 0 && text.length > 0) {
        summary.textContent += " · nothing to escape, the input is returned unchanged";
      }

      var escaped = "";
      for (var k = 0; k < text.length; k++) escaped += escapeChar(text[k]);
      output.textContent = escaped;
    }

    input.addEventListener("input", render);
    render();
  }

  // --------------------------------------------------------------- width

  function initWidth(root) {
    var initial = root.dataset.text || "café 🎉";
    var body = mount(root, "PEP 393: how wide is your string?");

    var controls = el("div", "tv-controls");
    var inWrap = el("label", "tv-field tv-grow");
    inWrap.appendChild(el("span", "tv-fieldlabel", "a Python str"));
    var input = el("input", "tv-input tv-mono");
    input.type = "text";
    input.value = initial;
    input.spellcheck = false;
    inWrap.appendChild(input);
    controls.appendChild(inWrap);

    var bins = el("div", "tv-bins");
    var binDefs = [
      { w: 1, name: "1 byte / char", kind: "Latin-1", ceil: "≤ U+00FF" },
      { w: 2, name: "2 bytes / char", kind: "UCS-2", ceil: "≤ U+FFFF" },
      { w: 4, name: "4 bytes / char", kind: "UCS-4", ceil: "≤ U+10FFFF" },
    ];
    var binEls = binDefs.map(function (b) {
      var box = el("div", "tv-bin");
      box.appendChild(el("span", "tv-binw", b.name));
      box.appendChild(el("span", "tv-binkind", b.kind));
      box.appendChild(el("span", "tv-binceil", b.ceil));
      bins.appendChild(box);
      return box;
    });

    var summary = el("div", "tv-summary");
    body.appendChild(controls);
    body.appendChild(bins);
    body.appendChild(summary);

    function render() {
      var text = input.value;
      var maxCP = 0;
      var count = 0;
      for (var ch of text) {
        count++;
        var cp = ch.codePointAt(0);
        if (cp > maxCP) maxCP = cp;
      }
      var width = maxCP <= 0xff ? 1 : maxCP <= 0xffff ? 2 : 4;
      binEls.forEach(function (box, i) {
        box.classList.toggle("tv-on", binDefs[i].w === width);
      });
      if (count === 0) {
        summary.textContent = "type something above";
        return;
      }
      summary.textContent =
        "largest code point U+" +
        maxCP.toString(16).toUpperCase().padStart(4, "0") +
        " → " +
        width +
        (width === 1 ? " byte/char · " : " bytes/char · ") +
        count +
        " code points · " +
        count * width +
        " bytes of storage";
    }

    input.addEventListener("input", render);
    render();
  }

  // ----------------------------------------------------- tokenizer stepper

  // A faithful subset of the WHATWG tokenizer: the tag and attribute states
  // plus DATA. Character references are simplified (a '&' that does not start a
  // known short entity is treated as text); the entity resolver widget covers
  // that path. Returns a precomputed trace so stepping forward and back is just
  // an index.
  function tokTrace(input) {
    var state = "DATA";
    var i = 0;
    var text = "";
    var cur = null;
    var tokens = [];
    var trace = [];
    var guard = 0;

    function ws(c) {
      return c === " " || c === "\t" || c === "\n" || c === "\f";
    }
    function alpha(c) {
      return c != null && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
    }
    function cloneTok(t) {
      return {
        kind: t.kind,
        name: t.name,
        text: t.text,
        selfClosing: t.selfClosing,
        attrs: (t.attrs || []).map(function (a) {
          return { name: a.name, value: a.value, hasValue: a.hasValue };
        }),
      };
    }
    function flushText() {
      if (text) {
        tokens.push({ kind: "TEXT", text: text });
        text = "";
      }
    }
    function emit() {
      if (cur) {
        tokens.push(cur);
        cur = null;
      }
    }
    function lastAttr() {
      return cur.attrs[cur.attrs.length - 1];
    }
    function snap(idx, from, note) {
      trace.push({
        idx: idx,
        state: from,
        note: note,
        tokens: tokens.map(cloneTok),
        pending: text,
        cur: cur ? cloneTok(cur) : null,
        done: state === "DONE",
      });
    }

    while (i <= input.length && guard++ < 4000) {
      var c = i < input.length ? input[i] : null;
      var from = state;
      var consume = true;
      var note = "";

      if (state === "DATA") {
        if (c === null) {
          flushText();
          state = "DONE";
          note = "end of input → flush the text run";
        } else if (c === "<") {
          flushText();
          state = "TAG OPEN";
          note = "see ‘<’ → a tag is starting";
        } else {
          text += c;
          note = "ordinary text → add ‘" + c + "’ to the run";
        }
      } else if (state === "TAG OPEN") {
        if (c === "/") {
          state = "END TAG OPEN";
          note = "see ‘/’ → this is an end tag";
        } else if (alpha(c)) {
          cur = { kind: "START", name: "", attrs: [], selfClosing: false };
          state = "TAG NAME";
          consume = false;
          note = "a letter → begin a start tag, reconsume it";
        } else {
          text += "<";
          state = "DATA";
          consume = false;
          note = "not a tag → ‘<’ is literal text, reconsume";
        }
      } else if (state === "END TAG OPEN") {
        if (alpha(c)) {
          cur = { kind: "END", name: "", attrs: [], selfClosing: false };
          state = "TAG NAME";
          consume = false;
          note = "begin an end tag, reconsume";
        } else {
          state = "DATA";
          note = "nothing valid → back to data";
        }
      } else if (state === "TAG NAME") {
        if (c === null) {
          emit();
          state = "DONE";
          note = "EOF";
        } else if (ws(c)) {
          state = "BEFORE ATTR NAME";
          note = "whitespace → the name is done";
        } else if (c === "/") {
          state = "SELF-CLOSING";
          note = "see ‘/’";
        } else if (c === ">") {
          emit();
          state = "DATA";
          note = "see ‘>’ → emit the tag";
        } else {
          cur.name += c.toLowerCase();
          note = "add ‘" + c + "’ to the tag name (lowercased)";
        }
      } else if (state === "BEFORE ATTR NAME") {
        if (c === null || c === "/" || c === ">") {
          state = "AFTER ATTR NAME";
          consume = false;
          note = "reconsume";
        } else if (ws(c)) {
          note = "skip whitespace";
        } else {
          cur.attrs.push({ name: c.toLowerCase(), value: "", hasValue: false });
          state = "ATTR NAME";
          note = "start a new attribute named ‘" + c + "’";
        }
      } else if (state === "ATTR NAME") {
        if (c === null || ws(c) || c === "/" || c === ">") {
          state = "AFTER ATTR NAME";
          consume = false;
          note = "the name is done, reconsume";
        } else if (c === "=") {
          state = "BEFORE ATTR VALUE";
          note = "see ‘=’ → a value follows";
        } else {
          lastAttr().name += c.toLowerCase();
          note = "add ‘" + c + "’ to the attribute name";
        }
      } else if (state === "AFTER ATTR NAME") {
        if (c === null) {
          emit();
          state = "DONE";
          note = "EOF";
        } else if (ws(c)) {
          note = "skip whitespace";
        } else if (c === "/") {
          state = "SELF-CLOSING";
          note = "";
        } else if (c === "=") {
          state = "BEFORE ATTR VALUE";
          note = "see ‘=’";
        } else if (c === ">") {
          emit();
          state = "DATA";
          note = "emit the tag";
        } else {
          cur.attrs.push({ name: c.toLowerCase(), value: "", hasValue: false });
          state = "ATTR NAME";
          note = "another attribute named ‘" + c + "’";
        }
      } else if (state === "BEFORE ATTR VALUE") {
        if (ws(c)) {
          note = "skip whitespace";
        } else if (c === '"') {
          state = "ATTR VALUE (DQ)";
          note = "open double quote";
        } else if (c === "'") {
          state = "ATTR VALUE (SQ)";
          note = "open single quote";
        } else if (c === ">") {
          emit();
          state = "DATA";
          note = "emit (the value is empty)";
        } else {
          lastAttr().hasValue = true;
          state = "ATTR VALUE (UNQ)";
          consume = false;
          note = "an unquoted value, reconsume";
        }
      } else if (state === "ATTR VALUE (DQ)") {
        if (c === null) {
          emit();
          state = "DONE";
          note = "EOF";
        } else if (c === '"') {
          state = "AFTER ATTR VALUE";
          note = "closing quote → the value is done";
        } else {
          lastAttr().value += c;
          lastAttr().hasValue = true;
          note = "add ‘" + c + "’ to the value";
        }
      } else if (state === "ATTR VALUE (SQ)") {
        if (c === null) {
          emit();
          state = "DONE";
          note = "EOF";
        } else if (c === "'") {
          state = "AFTER ATTR VALUE";
          note = "closing quote → the value is done";
        } else {
          lastAttr().value += c;
          lastAttr().hasValue = true;
          note = "add ‘" + c + "’ to the value";
        }
      } else if (state === "ATTR VALUE (UNQ)") {
        if (c === null) {
          emit();
          state = "DONE";
          note = "EOF";
        } else if (ws(c)) {
          state = "BEFORE ATTR NAME";
          note = "whitespace ends the value";
        } else if (c === ">") {
          emit();
          state = "DATA";
          note = "emit the tag";
        } else {
          lastAttr().value += c;
          note = "add ‘" + c + "’ to the value";
        }
      } else if (state === "AFTER ATTR VALUE") {
        if (c === null) {
          emit();
          state = "DONE";
          note = "EOF";
        } else if (ws(c)) {
          state = "BEFORE ATTR NAME";
          note = "";
        } else if (c === "/") {
          state = "SELF-CLOSING";
          note = "";
        } else if (c === ">") {
          emit();
          state = "DATA";
          note = "emit the tag";
        } else {
          state = "BEFORE ATTR NAME";
          consume = false;
          note = "reconsume";
        }
      } else if (state === "SELF-CLOSING") {
        if (c === ">") {
          cur.selfClosing = true;
          emit();
          state = "DATA";
          note = "self-closing ‘/>’ → emit the tag";
        } else {
          state = "BEFORE ATTR NAME";
          consume = false;
          note = "reconsume";
        }
      }

      snap(c === null ? input.length : i, from, note);
      if (state === "DONE") break;
      if (consume) i++;
    }
    return trace;
  }

  function tokenChip(t) {
    var chip = el("div", "tv-token tv-token-" + (t.kind || "TEXT").toLowerCase());
    if (t.kind === "TEXT") {
      chip.appendChild(el("span", "tv-tk", "TEXT"));
      chip.appendChild(el("span", "tv-tv", JSON.stringify(t.text)));
    } else {
      chip.appendChild(el("span", "tv-tk", t.kind === "END" ? "END" : "START"));
      var s = "<" + (t.kind === "END" ? "/" : "") + t.name;
      (t.attrs || []).forEach(function (a) {
        s += " " + a.name + (a.hasValue ? '="' + a.value + '"' : "");
      });
      s += (t.selfClosing ? "/" : "") + ">";
      chip.appendChild(el("span", "tv-tv", s));
    }
    return chip;
  }

  function initTok(root) {
    var initial = root.dataset.text || '<p class="x">Hi & bye</p>';
    var body = mount(root, "WHATWG tokenizer: step the state machine");

    var controls = el("div", "tv-controls");
    var inWrap = el("label", "tv-field tv-grow");
    inWrap.appendChild(el("span", "tv-fieldlabel", "markup"));
    var input = el("input", "tv-input tv-mono");
    input.type = "text";
    input.value = initial;
    input.spellcheck = false;
    inWrap.appendChild(input);
    controls.appendChild(inWrap);
    body.appendChild(controls);

    var tape = el("div", "tv-tape tv-mono");
    var stateBar = el("div", "tv-statebar");
    var stateBadge = el("span", "tv-state");
    var note = el("span", "tv-note");
    stateBar.appendChild(stateBadge);
    stateBar.appendChild(note);
    var tokensLabel = el("div", "tv-fieldlabel", "tokens emitted");
    var tokensBox = el("div", "tv-tokens");
    body.appendChild(tape);
    body.appendChild(stateBar);
    body.appendChild(tokensLabel);
    body.appendChild(tokensBox);

    var bar = el("div", "tv-stepbar");
    var btnReset = el("button", "tv-btn", "⟲ restart");
    var btnPrev = el("button", "tv-btn", "◀ back");
    var btnNext = el("button", "tv-btn", "step ▶");
    var btnPlay = el("button", "tv-btn", "▶ play");
    var counter = el("span", "tv-counter");
    btnReset.type = btnPrev.type = btnNext.type = btnPlay.type = "button";
    [btnReset, btnPrev, btnNext, btnPlay].forEach(function (b) {
      bar.appendChild(b);
    });
    bar.appendChild(counter);
    body.appendChild(bar);

    var trace = [];
    var step = 0;
    var timer = null;

    function buildTape(idx) {
      tape.textContent = "";
      var text = input.value;
      for (var k = 0; k < text.length; k++) {
        var cls = "tv-tch";
        if (k < idx) cls += " tv-tch-done";
        else if (k === idx) cls += " tv-tch-cur";
        tape.appendChild(el("span", cls, text[k] === " " ? "␣" : text[k]));
      }
      var eof = el("span", "tv-tch tv-tch-eof" + (idx >= text.length ? " tv-tch-cur" : ""), "EOF");
      tape.appendChild(eof);
    }

    function renderTokens(snapTokens, cur) {
      tokensBox.textContent = "";
      (snapTokens || []).forEach(function (t) {
        tokensBox.appendChild(tokenChip(t));
      });
      if (cur) {
        var c = tokenChip(cur);
        c.classList.add("tv-token-building");
        tokensBox.appendChild(c);
      }
      if (!snapTokens.length && !cur) {
        tokensBox.appendChild(el("span", "tv-empty", "none yet"));
      }
    }

    function show() {
      var s = trace[step];
      buildTape(s.idx);
      stateBadge.textContent = s.state;
      stateBadge.classList.toggle("tv-state-done", s.done);
      note.textContent = s.note;
      renderTokens(s.tokens, s.cur);
      counter.textContent = "step " + (step + 1) + " / " + trace.length;
      btnPrev.disabled = step === 0;
      btnNext.disabled = step >= trace.length - 1;
    }

    function rebuild() {
      stopPlay();
      trace = tokTrace(input.value);
      if (!trace.length) trace = [{ idx: 0, state: "DATA", note: "empty input", tokens: [], cur: null, done: true }];
      step = 0;
      show();
    }
    function go(n) {
      step = Math.max(0, Math.min(trace.length - 1, n));
      show();
    }
    function stopPlay() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        btnPlay.textContent = "▶ play";
      }
    }
    function togglePlay() {
      if (timer) {
        stopPlay();
        return;
      }
      if (step >= trace.length - 1) go(0);
      btnPlay.textContent = "❙❙ pause";
      timer = setInterval(function () {
        if (step >= trace.length - 1) {
          stopPlay();
          return;
        }
        go(step + 1);
      }, 650);
    }

    btnReset.addEventListener("click", function () {
      stopPlay();
      go(0);
    });
    btnPrev.addEventListener("click", function () {
      stopPlay();
      go(step - 1);
    });
    btnNext.addEventListener("click", function () {
      stopPlay();
      go(step + 1);
    });
    btnPlay.addEventListener("click", togglePlay);
    input.addEventListener("input", rebuild);
    rebuild();
  }

  // ------------------------------------------------------- entity resolver

  // A curated, sorted slice of the HTML5 named-character-reference table, both
  // the canonical "name;" forms and a few legacy semicolon-less ones, enough
  // to show binary search and longest-prefix matching honestly.
  var ENTITIES = [
    { name: "amp", cp: "&" },
    { name: "amp;", cp: "&" },
    { name: "apos;", cp: "'" },
    { name: "copy", cp: "©" },
    { name: "copy;", cp: "©" },
    { name: "deg;", cp: "°" },
    { name: "eacute", cp: "é" },
    { name: "eacute;", cp: "é" },
    { name: "euro;", cp: "€" },
    { name: "gt", cp: ">" },
    { name: "gt;", cp: ">" },
    { name: "hellip;", cp: "…" },
    { name: "larr;", cp: "←" },
    { name: "le;", cp: "≤" },
    { name: "lt", cp: "<" },
    { name: "lt;", cp: "<" },
    { name: "mdash;", cp: "—" },
    { name: "nbsp;", cp: " " },
    { name: "not", cp: "¬" },
    { name: "not;", cp: "¬" },
    { name: "notin;", cp: "∉" },
    { name: "para;", cp: "¶" },
    { name: "pound;", cp: "£" },
    { name: "quot", cp: '"' },
    { name: "quot;", cp: '"' },
    { name: "rarr;", cp: "→" },
    { name: "reg", cp: "®" },
    { name: "reg;", cp: "®" },
    { name: "sect;", cp: "§" },
    { name: "trade;", cp: "™" },
  ].sort(function (a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  function bsearch(key) {
    var lo = 0;
    var hi = ENTITIES.length - 1;
    var steps = [];
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var name = ENTITIES[mid].name;
      var dir = key === name ? "hit" : key < name ? "left" : "right";
      steps.push({ lo: lo, hi: hi, mid: mid, name: name, dir: dir });
      if (dir === "hit") return { found: ENTITIES[mid], steps: steps };
      if (dir === "left") hi = mid - 1;
      else lo = mid + 1;
    }
    return { found: null, steps: steps };
  }

  function glyphNbsp(s) {
    return s === " " ? "⍽ (NBSP)" : s;
  }

  function initEntity(root) {
    var initial = root.dataset.text || "&notit;";
    var body = mount(root, "unescape: resolving a character reference");

    var controls = el("div", "tv-controls");
    var inWrap = el("label", "tv-field tv-grow");
    inWrap.appendChild(el("span", "tv-fieldlabel", "a character reference"));
    var input = el("input", "tv-input tv-mono");
    input.type = "text";
    input.value = initial;
    input.spellcheck = false;
    inWrap.appendChild(input);
    controls.appendChild(inWrap);
    body.appendChild(controls);

    var examples = el("div", "tv-examples");
    examples.appendChild(el("span", "tv-fieldlabel", "try"));
    ["&amp;", "&copy", "&notin;", "&notit;", "&#x1F389;"].forEach(function (ex) {
      var b = el("button", "tv-chip", ex);
      b.type = "button";
      b.addEventListener("click", function () {
        input.value = ex;
        render();
      });
      examples.appendChild(b);
    });
    body.appendChild(examples);

    var out = el("div", "tv-resolve");
    body.appendChild(out);

    function row(label, value, cls) {
      var r = el("div", "tv-rrow");
      r.appendChild(el("span", "tv-rlabel", label));
      r.appendChild(el("span", "tv-rval " + (cls || ""), value));
      return r;
    }

    function render() {
      out.textContent = "";
      var s = input.value;
      if (s[0] !== "&") {
        out.appendChild(row("not a reference", "needs to start with ‘&’", "tv-rmiss"));
        return;
      }
      var rest = s.slice(1);

      if (rest[0] === "#") {
        var hex = rest[1] === "x" || rest[1] === "X";
        var digits = rest
          .slice(hex ? 2 : 1)
          .replace(/;.*$/, "")
          .replace(/[^0-9a-fA-F].*$/, hex ? "" : "");
        var dec = rest
          .slice(1)
          .replace(/;.*$/, "")
          .replace(/[^0-9].*$/, "");
        var num = hex ? parseInt(digits, 16) : parseInt(dec, 10);
        out.appendChild(row("kind", "numeric reference, base " + (hex ? "16 (hex)" : "10"), ""));
        if (isNaN(num)) {
          out.appendChild(row("result", "no digits → literal text", "tv-rmiss"));
          return;
        }
        var ch;
        if (num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) ch = "�";
        else ch = String.fromCodePoint(num);
        out.appendChild(row("code point", "U+" + num.toString(16).toUpperCase().padStart(4, "0") + " = " + num, ""));
        out.appendChild(row("resolves to", ch, "tv-rhit tv-rbig"));
        return;
      }

      // named: collect the name characters, then an optional ';'
      var m = rest.match(/^[a-zA-Z0-9]+/);
      var name = m ? m[0] : "";
      var hasSemi = rest[name.length] === ";";
      var token = name + (hasSemi ? ";" : "");
      var tail = rest.slice(name.length + (hasSemi ? 1 : 0));
      out.appendChild(row("kind", "named reference · token “" + token + "”", ""));
      if (!name) {
        out.appendChild(row("result", "no name → literal ‘&’", "tv-rmiss"));
        return;
      }

      // longest-prefix: try the whole token, then drop trailing characters
      var ladder = el("div", "tv-ladder");
      ladder.appendChild(el("span", "tv-rlabel", "longest match"));
      var matched = null;
      var matchLen = 0;
      for (var len = token.length; len >= 2; len--) {
        var key = token.slice(0, len);
        var res = bsearch(key);
        var pill = el("span", "tv-try" + (res.found ? " tv-try-hit" : " tv-try-miss"), key + (res.found ? " ✓" : " ✗"));
        ladder.appendChild(pill);
        if (res.found) {
          matched = res;
          matchLen = len;
          break;
        }
      }
      out.appendChild(ladder);

      if (!matched) {
        out.appendChild(
          row("result", "no entity matches → ‘&" + name + (hasSemi ? ";" : "") + "’ stays literal", "tv-rmiss"),
        );
        return;
      }

      // show the binary-search probes for the matched key
      var probes = el("div", "tv-probes");
      probes.appendChild(el("span", "tv-rlabel", "binary search"));
      matched.steps.forEach(function (p) {
        var arrow = p.dir === "hit" ? "✓ found" : p.dir === "left" ? "↑ go left" : "↓ go right";
        probes.appendChild(
          el("div", "tv-probe", "lo " + p.lo + " · hi " + p.hi + " · mid " + p.mid + " → “" + p.name + "”  " + arrow),
        );
      });
      out.appendChild(probes);

      var leftover = token.slice(matchLen) + tail;
      out.appendChild(row("resolves to", glyphNbsp(matched.found.cp), "tv-rhit tv-rbig"));
      if (leftover) {
        out.appendChild(row("leftover", "“" + leftover + "” stays literal", ""));
        out.appendChild(row("final", matched.found.cp + leftover, "tv-rhit"));
      }
    }

    input.addEventListener("input", render);
    render();
  }

  // ---------------------------------------------------------------- boot

  // ------------------------------------------------- interned atoms + bucket

  function initAtom(root) {
    var body = mount(root, "Interned atoms: one integer compare, one bucket");
    var ATOMS = {
      html: 1,
      head: 2,
      body: 3,
      div: 4,
      p: 5,
      a: 6,
      span: 7,
      ul: 8,
      li: 9,
      img: 10,
      table: 11,
      tr: 12,
      td: 13,
    };
    var DOC = ["html", "head", "body", "div", "p", "a", "span", "a", "div", "p", "a", "li", "div", "img"];

    var controls = el("div", "tv-controls");
    var field = el("label", "tv-field");
    field.appendChild(el("span", "tv-fieldlabel", "find_all(tag)"));
    var sel = el("select", "tv-input tv-mono");
    Object.keys(ATOMS).forEach(function (t) {
      var o = el("option", null, t);
      o.value = t;
      sel.appendChild(o);
    });
    sel.value = "a";
    field.appendChild(sel);
    controls.appendChild(field);
    var atomField = el("div", "tv-field");
    atomField.appendChild(el("span", "tv-fieldlabel", "atom"));
    var atomVal = el("span", "tv-probe");
    atomField.appendChild(atomVal);
    controls.appendChild(atomField);

    var docRow = el("div", "tv-doc");
    var cells = DOC.map(function (t) {
      var c = el("div", "tv-node");
      c.appendChild(el("span", "tv-nodetag", t));
      docRow.appendChild(c);
      return c;
    });
    var summary = el("div", "tv-summary");
    body.appendChild(controls);
    body.appendChild(docRow);
    body.appendChild(summary);

    function render() {
      var target = sel.value;
      var atom = ATOMS[target];
      atomVal.textContent = "TH_TAG_" + target.toUpperCase() + " = " + atom;
      var n = 0;
      cells.forEach(function (c, i) {
        var hit = DOC[i] === target;
        c.classList.toggle("tv-on", hit);
        if (hit) n++;
      });
      summary.textContent =
        "find_all('" +
        target +
        "') visits the " +
        n +
        " node" +
        (n === 1 ? "" : "s") +
        " in the " +
        target +
        "-bucket, not all " +
        DOC.length +
        ". Each match is one integer compare: node.atom == " +
        atom +
        ".";
    }
    sel.addEventListener("change", render);
    render();
  }

  // ------------------------------------------- O(N^2) -> O(N) id locator index

  function initIdIndex(root) {
    var body = mount(root, "css_path uniqueness: O(N²) scan vs a build-once index");
    var controls = el("div", "tv-controls");
    var field = el("label", "tv-field tv-grow");
    field.appendChild(el("span", "tv-fieldlabel", "elements carrying an id"));
    var slider = el("input", "tv-input");
    slider.type = "range";
    slider.min = "5";
    slider.max = "400";
    slider.step = "5";
    slider.value = "60";
    field.appendChild(slider);
    controls.appendChild(field);

    var compare = el("div", "tv-compare");
    var naiveCard = el("div", "tv-card tv-card-bad");
    naiveCard.appendChild(el("div", "tv-cardhead", "naive: scan the whole document per id"));
    var naiveVal = el("div", "tv-rbig");
    naiveCard.appendChild(naiveVal);
    naiveCard.appendChild(el("div", "tv-note", "O(N²)"));
    var idxCard = el("div", "tv-card tv-card-good");
    idxCard.appendChild(el("div", "tv-cardhead", "indexed: build the map once, then probe"));
    var idxVal = el("div", "tv-rbig");
    idxCard.appendChild(idxVal);
    idxCard.appendChild(el("div", "tv-note", "O(N)"));
    compare.appendChild(naiveCard);
    compare.appendChild(idxCard);

    var summary = el("div", "tv-summary");
    body.appendChild(controls);
    body.appendChild(compare);
    body.appendChild(summary);

    function fmt(n) {
      return n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : "" + n;
    }
    function render() {
      var N = +slider.value;
      var naive = N * N;
      var indexed = N + N;
      naiveVal.textContent = fmt(naive) + " ops";
      idxVal.textContent = fmt(indexed) + " ops";
      var ratio = Math.round(naive / indexed);
      summary.textContent =
        "Pathing every element costs N×N = " +
        fmt(naive) +
        " id comparisons the naive way, but N+N = " +
        fmt(indexed) +
        " with a build-once id→count map: about " +
        ratio +
        "× fewer at N=" +
        N +
        ". That gap is O(N²) against O(N).";
    }
    slider.addEventListener("input", render);
    render();
  }

  // --------------------------------------------------- node wrapper free list

  function initFreelist(root) {
    var body = mount(root, "Node wrappers: a bounded free list");
    var CAP = 8;
    var parked = 0;
    var live = 0;
    var stats = { alloc: 0, revive: 0, free: 0 };

    var controls = el("div", "tv-btnrow");
    function mkbtn(label) {
      var b = el("button", "tv-btn", label);
      controls.appendChild(b);
      return b;
    }
    var bWrap = mkbtn("wrap a node");
    var bFree = mkbtn("release one");
    var bBurst = mkbtn("find_all: wrap 6, release 6");
    var toggle = el("label", "tv-toggle");
    var cb = el("input");
    cb.type = "checkbox";
    cb.checked = true;
    toggle.appendChild(cb);
    toggle.appendChild(el("span", null, " pool on"));
    controls.appendChild(toggle);

    var poolRow = el("div", "tv-pool");
    var slots = [];
    for (var i = 0; i < CAP; i++) {
      var s = el("div", "tv-slot");
      poolRow.appendChild(s);
      slots.push(s);
    }
    var counters = el("div", "tv-counters");
    var cAlloc = el("span", "tv-stat");
    var cRevive = el("span", "tv-stat");
    var cFree = el("span", "tv-stat");
    var cLive = el("span", "tv-stat");
    counters.appendChild(cAlloc);
    counters.appendChild(cRevive);
    counters.appendChild(cFree);
    counters.appendChild(cLive);
    var summary = el("div", "tv-summary");
    body.appendChild(controls);
    body.appendChild(poolRow);
    body.appendChild(counters);
    body.appendChild(summary);

    function wrap() {
      if (cb.checked && parked > 0) {
        parked--;
        stats.revive++;
      } else {
        stats.alloc++;
      }
      live++;
    }
    function release() {
      if (live <= 0) return;
      live--;
      if (cb.checked && parked < CAP) {
        parked++;
      } else {
        stats.free++;
      }
    }
    function render() {
      slots.forEach(function (slot, idx) {
        slot.classList.toggle("tv-on", idx < parked);
      });
      cAlloc.textContent = "malloc: " + stats.alloc;
      cRevive.textContent = "revive: " + stats.revive;
      cFree.textContent = "free: " + stats.free;
      cLive.textContent = "live: " + live;
      summary.textContent = cb.checked
        ? "Released wrappers park on the list (max " +
          CAP +
          "); the next wrap revives one, so a burst of queries costs a few mallocs, not one per node."
        : "Pool off: every wrap is a malloc and every release a free, the free-threaded build's path, where the GIL cannot guard a shared list.";
    }
    bWrap.addEventListener("click", function () {
      wrap();
      render();
    });
    bFree.addEventListener("click", function () {
      release();
      render();
    });
    bBurst.addEventListener("click", function () {
      var k;
      for (k = 0; k < 6; k++) wrap();
      for (k = 0; k < 6; k++) release();
      render();
    });
    cb.addEventListener("change", render);
    render();
  }

  // -------------------------------------------------- IDNA / Punycode encoder

  // RFC 3492 Punycode encode of one label (array of code points) to ASCII,
  // without the xn-- prefix. This is the real bootstring algorithm.
  function punyEncode(input) {
    var base = 36,
      tmin = 1,
      tmax = 26,
      skew = 38,
      damp = 700,
      initialBias = 72,
      initialN = 128,
      delimiter = 0x2d;
    function adapt(delta, numpoints, first) {
      delta = first ? Math.floor(delta / damp) : delta >> 1;
      delta += Math.floor(delta / numpoints);
      var k = 0;
      for (; delta > ((base - tmin) * tmax) >> 1; k += base) {
        delta = Math.floor(delta / (base - tmin));
      }
      return Math.floor(k + ((base - tmin + 1) * delta) / (delta + skew));
    }
    function digit(d) {
      return d + (d < 26 ? 97 : 22);
    }
    var output = [];
    var n = initialN,
      delta = 0,
      bias = initialBias;
    var basic = input.filter(function (c) {
      return c < 0x80;
    });
    var b = basic.length;
    var h = b;
    basic.forEach(function (c) {
      output.push(c);
    });
    if (b > 0) output.push(delimiter);
    while (h < input.length) {
      var m = Infinity;
      input.forEach(function (c) {
        if (c >= n && c < m) m = c;
      });
      delta += (m - n) * (h + 1);
      n = m;
      input.forEach(function (c) {
        if (c < n) delta++;
        if (c === n) {
          var q = delta;
          for (var k = base; ; k += base) {
            var t = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
            if (q < t) break;
            output.push(digit(t + ((q - t) % (base - t))));
            q = Math.floor((q - t) / (base - t));
          }
          output.push(digit(q));
          bias = adapt(delta, h + 1, h === b);
          delta = 0;
          h++;
        }
      });
      delta++;
      n++;
    }
    return output
      .map(function (c) {
        return String.fromCharCode(c);
      })
      .join("");
  }

  function initIdna(root) {
    var body = mount(root, "IDNA host encoding: map, normalize (NFC), Punycode");
    var controls = el("div", "tv-controls");
    var field = el("label", "tv-field tv-grow");
    field.appendChild(el("span", "tv-fieldlabel", "a Unicode host"));
    var input = el("input", "tv-input tv-mono");
    input.type = "text";
    input.value = root.dataset.text || "café.example";
    input.spellcheck = false;
    field.appendChild(input);
    controls.appendChild(field);

    var steps = el("div", "tv-steps");
    var out = el("div", "tv-output tv-mono");
    var note = el(
      "div",
      "tv-note",
      "The live demo lowercases as its UTS-46 step; the library uses the full Unicode mapping table.",
    );
    var summary = el("div", "tv-summary");
    body.appendChild(controls);
    body.appendChild(steps);
    body.appendChild(out);
    body.appendChild(note);
    body.appendChild(summary);

    function cps(s) {
      var a = [];
      for (var ch of s) a.push(ch.codePointAt(0));
      return a;
    }
    function render() {
      steps.textContent = "";
      var labels = input.value.split(".");
      var asciiLabels = labels.map(function (label) {
        if (label === "") return "";
        var mapped = label.toLowerCase();
        var nfc = mapped.normalize("NFC");
        var isAscii = /^[\x00-\x7f]*$/.test(nfc);
        var ascii = isAscii ? nfc : "xn--" + punyEncode(cps(nfc));
        var step = el("div", "tv-step");
        step.appendChild(el("span", "tv-steplabel", label));
        step.appendChild(el("span", "tv-steparrow", "→"));
        step.appendChild(el("span", "tv-mono", isAscii ? nfc + "  (ASCII, kept)" : nfc + "  →  " + ascii));
        steps.appendChild(step);
        return ascii;
      });
      out.textContent = asciiLabels.join(".");
      summary.textContent =
        "Each label is mapped and normalized to NFC, then any label with non-ASCII becomes xn-- plus its Punycode. That is the ASCII form DNS carries.";
    }
    input.addEventListener("input", render);
    render();
  }

  // ----------------------------------------------- benchmark CPU determinism

  function initBench(root) {
    var body = mount(root, "Why the gate counts instructions, and pins the CPU");
    var controls = el("div", "tv-controls");
    var field = el("label", "tv-field tv-grow");
    field.appendChild(el("span", "tv-fieldlabel", "bytes to copy (one memcpy)"));
    var slider = el("input", "tv-input");
    slider.type = "range";
    slider.min = "64";
    slider.max = "8192";
    slider.step = "64";
    slider.value = "4096";
    field.appendChild(slider);
    controls.appendChild(field);
    var toggle = el("label", "tv-toggle");
    var cb = el("input");
    cb.type = "checkbox";
    toggle.appendChild(cb);
    toggle.appendChild(el("span", null, " pin GLIBC_TUNABLES (force SSE2 everywhere)"));
    controls.appendChild(toggle);

    var compare = el("div", "tv-compare");
    var intel = el("div", "tv-card");
    intel.appendChild(el("div", "tv-cardhead", "Intel Xeon runner"));
    var iVal = el("div", "tv-rbig");
    var iSub = el("div", "tv-note");
    intel.appendChild(iVal);
    intel.appendChild(iSub);
    var amd = el("div", "tv-card");
    amd.appendChild(el("div", "tv-cardhead", "AMD EPYC runner"));
    var aVal = el("div", "tv-rbig");
    var aSub = el("div", "tv-note");
    amd.appendChild(aVal);
    amd.appendChild(aSub);
    compare.appendChild(intel);
    compare.appendChild(amd);

    var verdict = el("div", "tv-verdict");
    var summary = el("div", "tv-summary");
    body.appendChild(controls);
    body.appendChild(compare);
    body.appendChild(verdict);
    body.appendChild(summary);

    function render() {
      var bytes = +slider.value;
      var pinned = cb.checked;
      var intelLane = pinned ? 16 : 64;
      var amdLane = 16;
      var iInstr = Math.ceil(bytes / intelLane);
      var aInstr = Math.ceil(bytes / amdLane);
      iVal.textContent = iInstr + " instrs";
      aVal.textContent = aInstr + " instrs";
      iSub.textContent = pinned ? "SSE2, 16 B/instr" : "AVX-512, 64 B/instr";
      aSub.textContent = "SSE2, 16 B/instr";
      var same = iInstr === aInstr;
      intel.classList.toggle("tv-card-good", same);
      intel.classList.toggle("tv-card-bad", !same);
      amd.classList.toggle("tv-card-good", same);
      amd.classList.toggle("tv-card-bad", !same);
      if (same) {
        verdict.textContent = "identical counts → a real regression would stand out";
        verdict.className = "tv-verdict tv-v-clean";
      } else {
        var d = (Math.abs(iInstr - aInstr) / Math.min(iInstr, aInstr)) * 100;
        verdict.textContent =
          "counts differ by " + d.toFixed(0) + "% for the SAME code → a false regression, pure CPU luck";
        verdict.className = "tv-verdict tv-v-dirty";
      }
      summary.textContent = pinned
        ? "Pinning forces the SSE2 memcpy on every runner, so the count reproduces and the gate compares like with like."
        : "GitHub picks the CPU; glibc picks the memcpy. The same source counts differently on Intel and AMD, which reads as a regression that never happened.";
    }
    slider.addEventListener("input", render);
    cb.addEventListener("change", render);
    render();
  }

  function boot() {
    var widgets = [
      ["tv-swar", initSwar],
      ["tv-scan", initScan],
      ["tv-width", initWidth],
      ["tv-tok", initTok],
      ["tv-entity", initEntity],
      ["tv-atom", initAtom],
      ["tv-idindex", initIdIndex],
      ["tv-freelist", initFreelist],
      ["tv-idna", initIdna],
      ["tv-bench", initBench],
    ];
    widgets.forEach(function (pair) {
      var nodes = document.querySelectorAll("." + pair[0]);
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node.dataset.tvInit) continue;
        node.dataset.tvInit = "1";
        try {
          pair[1](node);
        } catch (err) {
          node.appendChild(el("div", "tv-empty", "widget failed to load"));
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
