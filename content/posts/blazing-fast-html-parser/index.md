+++
author = "Bernat Gabor"
title = "Building a fast HTML toolkit in C for Python"
description = "How turbohtml builds a fast HTML toolkit in C for Python: SWAR, SIMD, zero-copy, interned atoms, IDNA, LTO/PGO, and honest benchmarking, 3-22x faster."
keywords = [ "html parser", "html toolkit", "python c extension", "simd", "swar", "zero-copy", "tokenizer", "idna", "punycode", "pgo", "lto", "free-threading", "benchmarking", "turbohtml", "lxml alternative", "beautifulsoup alternative"]
image = "splash.webp"
images = [ "splash.webp"]
tags = [ "python", "c", "performance", "simd", "html", "parser", "tokenizer", "unicode", "turbohtml", "idna", "pgo", "lto", "benchmarking"]
draft = true
slug = "blazing-fast-html-parser"
date = 2026-06-18T09:00:00Z
+++

{{< callout kind="note" title="TLDR: turbohtml does HTML escape, unescape, tokenize, query, serialize, and URL work in C, 3-22x faster than Python's standard library. The recurring trick is skipping work:" >}}

- **Scan in blocks, not characters.** [SWAR](#the-swar-trick-checking-eight-bytes-with-one-subtraction) clears eight
  bytes with a subtraction, [SIMD](#sixteen-bytes-with-one-shuffle) sixteen with one shuffle; a clean block costs almost
  nothing.
- **Measure, then write.** [One pass sizes the output exactly](#two-passes-measure-then-write), so the second allocates
  once and bulk-copies the clean stretches.
- **Keep text at its native width and copy it rarely.** The tokenizer stamps its state machine
  [once per width](#stamping-the-machine-once-per-width) and hands back
  [zero-copy slices](#never-copy-text-you-dont-have-to) into the input.
- **The same instincts across the toolkit.** Tag names [interned to integers](#interning-names-to-integers), an
  [id index built once](#building-the-index-once-instead-of-every-time) that turns an O(N²) path walk linear, and
  [wrapper objects recycled](#recycling-the-wrapper-objects) on a free list.
- **When the work is a standard, not a scan.** Host encoding needs
  [Punycode, normalization, and Hangul by arithmetic](#when-the-work-is-a-standard-not-a-scan), with the Unicode tables
  generated at build time.
- **Down to the build and the benchmark.** [LTO and PGO](#teaching-the-compiler-what-is-hot) squeeze the machine code;
  the CI gate [counts instructions under Callgrind](#measuring-without-lying-to-yourself) so a regression cannot hide in
  the noise.
- **Free-threaded.** No shared mutable state, so it declares `Py_MOD_GIL_NOT_USED` and runs on the
  [no-GIL build](https://peps.python.org/pep-0703/) without forcing the lock back on.

{{< /callout >}}

_turbohtml was built with Claude (Opus 4.8), not by hand, over a month and close to 300 iterations. I review the code
and own its correctness; [more on how, and my thanks, at the end](#how-this-was-built)._

This started as a proposal to CPython. The standard library's
[`html.escape`](https://docs.python.org/3/library/html.html#html.escape) and
[`html.unescape`](https://docs.python.org/3/library/html.html#html.unescape) are written in pure Python: `escape` runs
up to five `str.replace` passes, and `unescape` runs a regex with a per-match Python callback over the 2,231-entry HTML5
entity table. Both sit on hot paths, since `html.parser.HTMLParser` calls `unescape` on every run of text it sees, so I
[opened an issue](https://github.com/python/cpython/issues/151024) and a
[pull request](https://github.com/python/cpython/pull/151025) to add a small C accelerator behind them, keeping the
Python versions as the [PEP 399](https://peps.python.org/pep-0399/) fallback.

The core developers turned it down, and their reasons were fair. A C extension is a maintenance burden, hand-written
SIMD more so, and they were clear they did not want to carry vector code in the standard library; on top of that
`HTMLParser` is still being rewritten, and there is talk of a unified `xml.escape` that might one day want to share an
accelerator. One of the maintainers
[suggested PyPI as the better home](https://github.com/python/cpython/issues/151024#issuecomment-4640666387) for this
rather than the standard library. So that is where it went, as [turbohtml](https://turbohtml.readthedocs.io/).

The standard library is right to be wary of SIMD in code that has to build everywhere and last decades. But once the
code lived on PyPI instead, that caution stopped applying, and it left a question I wanted to answer: if nothing is
off-limits, how fast can HTML-domain work get? So I set the scope to the whole HTML domain and kept pushing. turbohtml
grew from three functions into a toolkit. It still escapes, unescapes, and tokenizes, matching `html.escape`,
`html.unescape`, and `html.parser` byte for byte; on top of that it builds a tree, queries it with CSS and XPath,
serializes, sanitizes, minifies HTML and CSS and JavaScript, extracts metadata, and parses URLs, all over one C core and
behind a thin typed Python facade. What it does, and what it refuses to do, follows from a short list of design
principles worth stating before the techniques.

## Design principles

A handful of rules decide what turbohtml is, and they explain most of the choices in the rest of this piece.

- **Speed over ease of maintenance.** The hot path is C: the tokenizer, the WHATWG tree builder, the CSS and XPath
  engines, escaping, and serialization all run over one
  [bump-allocated arena](https://en.wikipedia.org/wiki/Region-based_memory_management) that holds no Python objects.
  Python appears only at the typed edge, a thin facade over the nodes you actually touch.
- **A modern, fully typed API.** Every concept carries one name and the whole surface is annotated. turbohtml is not a
  drop-in for what it replaces; the `turbohtml.migration` modules and guides translate
  [BeautifulSoup](https://www.crummy.com/software/BeautifulSoup/), [lxml](https://lxml.de/),
  [html5lib](https://github.com/html5lib/html5lib-python), [markupsafe](https://pypi.org/project/MarkupSafe/), and
  standard-library code rather than aliasing their APIs.
- **Still maintainable.** The C is split by subsystem and written to read as its own documentation, and both the Python
  and C coverage gates require 100% line and branch coverage, on gcc and llvm-cov alike, before a change lands.
- **WHATWG conformance first.** The tokenizer and tree builder follow the
  [WHATWG HTML standard](https://html.spec.whatwg.org/multipage/parsing.html) state by state, validated against the
  html5lib-tests suite browsers use. It matches a competitor's behavior only where the spec leaves the answer open.
- **Free-threading ready.** The extension holds no shared mutable state and declares free-threading support, and every
  tree edit and string read runs under a per-tree [critical section](https://en.wikipedia.org/wiki/Critical_section)
  that snapshots the arena before any Python callback, so a concurrent mutation can never tear a walk.
- **Native and dependency-free.** The core is pure C, no libxml2 or lxml underneath, accelerated with SIMD, SWAR, and an
  incremental codec. It reuses the standard library for solved problems like
  [regex matching](https://docs.python.org/3/library/re.html) instead of reimplementing them.
- **Benchmark-driven and competitor-informed.** Designs are measured with pyperf against the fastest implementations
  across C, Rust, and Go, and adopt their proven techniques: the [lexbor](https://github.com/lexbor/lexbor) and
  [html5ever](https://github.com/servo/html5ever) arena layout, html5ever's bulk text scan, the Rust
  [linkify](https://github.com/robinst/linkify) scanner. A change that regresses the benchmarks does not ship.

I want to walk you through how. None of the techniques are mine; they come from CPython itself, from
[simdjson](https://github.com/simdjson/simdjson), from [html5ever](https://github.com/servo/html5ever), and from a
decades-old page of [bit tricks](https://graphics.stanford.edu/~seander/bithacks.html). Putting them together in one
place taught me a lot, and I think the ideas are worth knowing even if you never touch HTML. If you have written C
before and know roughly what a CPU does, you have enough background to follow along. Let me start with why any of this
matters.

## Why bother

Escaping runs on every fragment of text a web app renders. Unescaping runs on every chunk of text an HTML parser hands
back. Tokenizing runs on every document you scrape. These are the kind of functions that get called millions of times,
so a constant-factor speedup on each call adds up to real time saved.

Here is the shape of the gap, measured with [pyperf](https://pyperf.readthedocs.io) on CPython 3.14 against the standard
library:

{{< bench-table you=2 nums="3" >}} operation | input | turbohtml | Python stdlib ; escape | prose, nothing to escape |
0.12 ms | 2.66 ms (22x) ; escape | real HTML (4 MiB) | 1.35 ms | 4.88 ms (3.6x) ; unescape | entity-heavy text | 10.4 ms
| 78.5 ms (7.6x) ; tokenize | typical markup | 30.3 µs | 449 µs (14.8x) ; tokenize | a 7.9 MB HTML spec source | 37.0 ms
| 399 ms (10.8x) {{< /bench-table >}}

Numbers vary with input and hardware; reproduce them with `tox -e bench` against the
[benchmark corpus](https://github.com/tox-dev/turbohtml/tree/main/tools) (Project Gutenberg's
[_War and Peace_](https://www.gutenberg.org/ebooks/2600), the [WHATWG](https://html.spec.whatwg.org/) and
[ECMAScript](https://tc39.es/ecma262/) specs) in the repo.

The standard library is not slow because its authors were careless. It is slow because it is written in Python, and
Python pays an interpreter cost on every character it touches. `html.unescape` calls a Python function for every entity
it finds. `html.parser` runs a regular expression and then steps through matches in Python. Rewriting in C removes the
interpreter from the inner loop, and that alone buys a few times speedup. The rest of the gap comes from being clever
about what work to do at all, which is the interesting part.

A recurring theme runs through everything below: **the fastest work is the work you skip.** Most text needs no escaping.
Most characters in a document are ordinary letters. If you can confirm "nothing interesting here" for a big block of
text in one cheap step, you have already won. Let me show you the cheapest way I know to do that.

## Scanning sixteen bytes at a time

Take `escape`. Its job is to replace five characters (`&`, `<`, `>`, `"`, `'`) with their entity forms and leave
everything else alone. The naive version looks at one character, decides, and moves on:

```c
for each character:
    if it is special, append the replacement
    else, append the character
```

That is a branch per character. For a paragraph of prose where nothing needs escaping, you pay that branch thousands of
times to confirm there was nothing to do. We can do better by asking a different question: instead of "is *this* byte
special?", ask "does this *block* of bytes contain anything special?" and answer it for many bytes at once.

### The SWAR trick: checking eight bytes with one subtraction

The oldest version of this idea needs no special hardware, just a 64-bit integer. It is called
[SWAR](https://en.wikipedia.org/wiki/SWAR), short for "SIMD within a register": you treat one wide integer as a row of
small lanes and operate on all of them together with ordinary arithmetic.

The building block is a test for whether a word contains a zero byte. Here it is, lifted from
[Sean Anderson's bit-twiddling collection](https://graphics.stanford.edu/~seander/bithacks.html):

```c
#define ONES  0x0101010101010101ULL  // a 1 in the low bit of every byte
#define HIGHS 0x8080808080808080ULL  // a 1 in the high bit of every byte

uint64_t has_zero(uint64_t word) {
    return (word - ONES) & ~word & HIGHS;
}
```

The result is nonzero exactly when some byte of `word` is zero. The reasoning fits in three steps. Subtracting `ONES`
takes one off each byte lane. A lane holding `0x00` borrows and wraps to `0xFF`, which sets its high bit. The `& ~word`
term keeps a high bit only where the original byte had its high bit clear, which rules out lanes that were already big
(a byte like `0x80` would also look "set" after the subtraction, and we do not want that false alarm). The final
`& HIGHS` throws away everything except the per-lane high bits. What survives is a high bit in each lane that started at
zero.

That finds zero bytes. We want to find a specific byte, say `&`. The fix is a single XOR. Pick the byte you are hunting,
broadcast it into all eight lanes by multiplying with `ONES`, and XOR it against the word. Every lane that held your
byte becomes `0x00`, and now `has_zero` lights it up. turbohtml writes it like this:

```c
static inline uint64_t swar_hasbyte(uint64_t word, uint8_t byte) {
    uint64_t lanes = word ^ (ONES * byte);
    return (lanes - ONES) & ~lanes & HIGHS;
}
```

Eight bytes, one comparison, no per-character branch. To check all five specials in a block, you OR five of these
together. If the combined result is zero, the whole eight-byte block is clean and you can copy it straight through.

Here is the trick running for real. Type eight characters, pick the byte to hunt for, and watch the XOR turn matches
into `0x00` and the has-zero mask light up those lanes (the mask below is computed with real 64-bit math, so it is the
same arithmetic the C runs):

{{< swar-viz text="Tom & cats" target="&" >}}

This SWAR test is the portable fallback. It is also what `glibc` uses inside
[`strlen`](https://en.cppreference.com/w/c/string/byte/strlen) and `memchr` when no vector instructions are available.
On a real CPU we can do better, because the hardware has instructions built for exactly this.

### Sixteen bytes with one shuffle

Every modern CPU has vector registers: 128 bits wide, holding sixteen bytes, with instructions that compare all sixteen
lanes in one step. This is [SIMD](https://en.wikipedia.org/wiki/Single_instruction,_multiple_data) proper, one
instruction working on many lanes. On x86 the relevant instruction set is [SSE2](https://en.wikipedia.org/wiki/SSE2); on
ARM (including Apple Silicon) it is
[NEON](<https://en.wikipedia.org/wiki/ARM_architecture_family#Advanced_SIMD_(Neon)>). turbohtml uses whichever the build
target has and falls back to SWAR otherwise.

The straightforward way on x86 is to compare the sixteen bytes against each special and OR the results:

```c
__m128i bytes = _mm_loadu_si128((const __m128i *)block);
__m128i hits  = _mm_cmpeq_epi8(bytes, _mm_set1_epi8('&'));
hits = _mm_or_si128(hits, _mm_cmpeq_epi8(bytes, _mm_set1_epi8('<')));
hits = _mm_or_si128(hits, _mm_cmpeq_epi8(bytes, _mm_set1_epi8('>')));
// ... '"' and '\'' when quoting
```

Each [`_mm_cmpeq_epi8`](https://www.felixcloutier.com/x86/pcmpeqb:pcmpeqw:pcmpeqd) sets a lane to `0xFF` on a match and
`0x00` otherwise. After the ORs, `hits` has `0xFF` wherever any special sits.

These `_mm_*` names are not magic incantations. Each is an SSE2 or SSSE3 _intrinsic_, a thin wrapper the compiler turns
into a single CPU instruction, and you can look any of them up in the
[Intel Intrinsics Guide](https://www.intel.com/content/www/us/en/docs/intrinsics-guide/index.html). The NEON `v*` names
play the same role on ARM and live in
[Arm's NEON intrinsics reference](https://arm-software.github.io/acle/neon_intrinsics/advsimd.html).

On ARM, turbohtml uses a sharper trick borrowed from [pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark)
and the [simdjson](https://arxiv.org/abs/1902.08318) line of work. Look at the five specials in hex: `"` is `0x22`, `&`
is `0x26`, `'` is `0x27`, `<` is `0x3C`, `>` is `0x3E`. Their low four bits (the low nibble) are all different. So you
can build a sixteen-entry table indexed by low nibble, put each special's byte value in its slot, and zero everywhere
else. One NEON shuffle instruction ([`vqtbl1q_u8`](https://arm-software.github.io/acle/neon_intrinsics/advsimd.html))
looks up all sixteen lanes against that table at once. Compare the lookup result against the original bytes, and a lane
matches only when the byte is that special:

```c
static const uint8_t NIBBLE_SPECIALS[16] =
    {0x7F, 0, '"', 0, 0, 0, '&', '\'', 0, 0, 0, 0, '<', 0, '>', 0};
//   ^idx0 holds 0x7F so a byte like 0x10 (low nibble 0) never false-matches
```

A whole block classified with one table lookup and one compare. The comment in the source calls it "the
[PSHUFB](https://www.felixcloutier.com/x86/pshufb) trick," after the x86 instruction that started it.
[Geoff Langdale](https://branchfree.org/) and [Daniel Lemire](https://lemire.me/blog/) have written it up in depth if
you want to go deeper; their UTF-8 validator classifies bytes
[in less than one instruction each](https://arxiv.org/abs/2010.03090) using the same nibble-table idea.

### From "something is here" to "here is where"

Knowing a block is dirty is only half the job; the writing pass needs to know *which* lanes. The vector compare gives a
sixteen-lane result, but we want it as a plain integer bitmask we can pick bits out of. On x86 that is one instruction,
[`_mm_movemask_epi8`](https://www.felixcloutier.com/x86/pmovmskb), which takes the high bit of each of the sixteen lanes
and packs them into a sixteen-bit number.

ARM has no such instruction, which tripped me up the first time. The workaround comes from
[Danila Kutenin](https://developer.arm.com/community/arm-community-blogs/b/servers-and-cloud-computing-blog/posts/porting-x86-vector-bitmask-optimizations-to-arm-neon):
treat the comparison result as eight 16-bit lanes, shift each right by four and narrow it to a byte, and you get a
64-bit value where each input byte contributed one nibble. A matched byte becomes `0xF`, an unmatched one becomes `0`.
It costs two instructions instead of one, and it is good enough.

Once the mask is an integer, two more bit tricks walk it. `__builtin_ctzll(mask)`
[counts the trailing zeros](https://en.wikipedia.org/wiki/Find_first_set), which is the index of the lowest set bit, so
it points at the first match. `mask & (mask - 1)` clears that lowest bit. Loop on those two and you visit every special
in the block, in order, touching nothing in between:

```c
do {
    Py_ssize_t index = SPECIAL_INDEX(mask);        // ctz: first match
    memcpy(out, in + prev, index - prev);          // copy the clean gap before it
    out += write_escaped(out, in[index]);          // write the entity
    mask = SPECIAL_CLEAR(mask, index);             // mask &= mask - 1: drop it
    prev = index + 1;
} while (mask != 0);
```

The clean stretch between two specials moves with one [`memcpy`](https://en.cppreference.com/w/c/string/byte/memcpy).
Only the specials themselves get rewritten. A block with no specials skips the loop and copies all sixteen bytes at
once.

Try it on your own text below. The bytes group into blocks; each block reports whether it is clean (one `memcpy`) or
dirty (copy the gaps, rewrite the specials), and the running total is the exact output size the counting pass computes.
Flip the block size between the 8-byte SWAR word and the 16-byte SIMD register to see how much each step clears:

{{< simd-scan text=`Tom & Jerry <3 "html" don't` >}}

## Two passes: measure, then write

There is a structural decision underneath all of this. To build the output string, turbohtml runs the input twice.

The first pass counts. It scans the input with the same block trick and adds up how much each special grows the output
(`&amp;` adds four characters over `&`, `&lt;` adds three, and so on), without writing anything. At the end it knows the
exact final length. Then it allocates the output string once, at exactly the right size, and the second pass fills it.

Two scans of the input sounds wasteful next to one. It usually is not. The alternative, writing into a buffer that grows
as you go, copies the data you already wrote every time the buffer doubles, and the growth path adds a bounds check to
every append. Counting first means the second pass writes each output byte exactly once into a buffer it never has to
resize. The counting pass is cheap because it is the block scan we already built, with no writes to slow it down.

The counting is branchless too, which matters because a branch the predictor cannot guess costs more than the work it
guards. Rather than test each byte and add to a running total, turbohtml turns the comparison straight into a number.
Each special's compare gives a lane of `0xFF` on a match; AND that with the special's growth amount and the matched
lanes hold the growth while the rest hold zero. Summing all sixteen lanes with one instruction gives the block's total
growth, no per-byte branch in sight:

```c
// each match becomes 0xFF; AND with the growth turns it into 4, 3, or 5
__m128i extras = _mm_and_si128(_mm_cmpeq_epi8(bytes, _mm_set1_epi8('&')), _mm_set1_epi8(4));
extras = _mm_add_epi8(extras, _mm_and_si128(_mm_cmpeq_epi8(bytes, _mm_set1_epi8('<')), _mm_set1_epi8(3)));
// ... '>' adds 3, '"' and '\'' add 5
__m128i sums = _mm_sad_epu8(extras, _mm_setzero_si128());  // sum all 16 lanes at once
```

[`_mm_sad_epu8`](https://www.felixcloutier.com/x86/psadbw) exists to add up sixteen bytes in one shot. On ARM the nibble
table from earlier does double duty: a second table maps each special's low nibble to its growth, and one horizontal add
([`vaddvq_u8`](https://arm-software.github.io/acle/neon_intrinsics/advsimd.html)) totals the lanes. Either way, sizing a
clean block costs a few instructions and no branches.

The measure pass also hands us a shortcut. If the count comes back zero, nothing needs escaping, and the input is
already its own answer:

```c
if (extra == 0) {
    return PyUnicode_FromObject(text);  // hand back the original, no copy
}
```

That single check is why the "prose, nothing to escape" row up top shows a 22x speedup. The standard library walks the
whole string building a new one; turbohtml scans it sixteen bytes at a step, sees nothing, and returns the string it was
given.

The sizing pass leans on a CPython detail worth knowing. A Python `str` is allocated for a known length and a known
maximum character value, through
[`PyUnicode_New(length, maxchar)`](https://docs.python.org/3/c-api/unicode.html#c.PyUnicode_New), part of CPython's
public Unicode C API alongside the
[`PyUnicode_1BYTE_KIND`](https://docs.python.org/3/c-api/unicode.html#c.PyUnicode_1BYTE_KIND),
[`PyUnicode_DATA`](https://docs.python.org/3/c-api/unicode.html#c.PyUnicode_DATA), and
[`PyUnicode_FindChar`](https://docs.python.org/3/c-api/unicode.html#c.PyUnicode_FindChar) calls in the later snippets.
Because we computed both numbers in pass one, we get a correctly sized buffer in one allocation and write straight into
it, no reallocation, no waste. I will come back to that `maxchar` in a moment, because it ties into how strings are
stored.

## Going backwards: unescape

`unescape` is the mirror image, and it reuses the same instinct: hop to the next interesting spot, bulk-copy everything
in between. The interesting character here is `&`, the start of every entity.

To find the next `&`, turbohtml first probes the next sixteen bytes inline, and only if that comes up empty does it call
`memchr` over the rest:

```c
// in reference-dense text the next '&' is a handful of characters away,
// so probe inline first; memchr's call cost only pays off on long spans
Py_ssize_t probe_end = from + 16 < length ? from + 16 : length;
for (Py_ssize_t pos = from; pos < probe_end; pos++) {
    if (input[pos] == '&') return pos;
}
const uint8_t *hit = memchr(input + probe_end, '&', length - probe_end);
```

[`memchr`](https://en.cppreference.com/w/c/string/byte/memchr) is itself vectorized in any decent C library, so on a
long clean span it races ahead at memory speed. The text between two entities copies in one `memcpy`. Every character
that is not part of an entity is touched once, by a bulk copy, never inspected on its own.

When it lands on an `&`, it resolves the entity. Numeric ones like `&#127881;` parse the digits. Named ones like `&amp;`
need a lookup, and HTML has about 2,000 of them. A [binary search](https://en.wikipedia.org/wiki/Binary_search) over a
sorted table finds any of them in around eleven comparisons, but most real text uses only a handful, so turbohtml checks
those first with one comparison each before falling back to the search:

```c
switch (name[0]) {
case 'a':
    if (len == 4 && memcmp(name, "amp;", 4) == 0) return &entities[INDEX_AMP];
    if (len == 5 && memcmp(name, "apos;", 5) == 0) return &entities[INDEX_APOS];
    break;
case 'g':
    if (len == 3 && memcmp(name, "gt;", 3) == 0) return &entities[INDEX_GT];
    // lt, quot ...
}
// fall through to the ~11-step binary search
```

The longest-prefix rule is the subtle part. A reference does not need its trailing semicolon, so the matcher tries the
whole name, then keeps dropping the last character until something in the table matches. That is why `&notit;` becomes
`¬it;`: `not` is the longest prefix that is a real entity, and `it;` is left as plain text. Try a few below and watch
the binary search narrow and the prefix shrink (the table here is a small sorted sample of the real ~2,000 entries):

{{< entity-resolver text="&notit;" >}}

There is one more wrinkle worth showing. Unescaping can introduce a character wider than the input had (an emoji hiding
in `&#127881;` inside otherwise-ASCII text). To handle this without paying for wide storage when it never happens, the
output buffer starts narrow, one byte per character, so clean spans are a plain `memcpy`. The first time an entity
produces a character above `0xFF`, turbohtml widens what it has written so far in place, walking back to front so the
copy never overwrites a byte it still needs to read. After that it stays wide. Text that never needs it never pays for
it.

Picking the final width needs one more number, the largest character in the result, which tells `PyUnicode_New` how wide
to make the output string. Tracking the exact maximum would mean a comparison on every character. turbohtml cheats with
a bitwise OR instead. It keeps a `seen` value and ORs every emitted character into it. CPython only ever sorts a string
into one of three bins, at `0x7F`, `0xFF`, and `0xFFFF`, and an OR can push `seen` past one of those boundaries only if
some character crossed it. So the OR'd value lands in the same bin as the true maximum, for the price of one branchless
operation:

```c
seen |= character;   // accumulate; can't cross a width bin unless a character did
// ...
PyUnicode_New(count, seen > 0xFFFF ? 0x10FFFF : seen);
```

That idea, storing text at the narrowest width it needs, is the whole story of the tokenizer, so let me turn to that.

## The tokenizer: a spec-exact state machine

Escaping and unescaping are small. The tokenizer is where the interesting structure lives.

Tokenizing means turning a string of HTML into a stream of pieces: a start tag here, a run of text, an end tag, a
comment. The [WHATWG HTML specification](https://html.spec.whatwg.org/multipage/parsing.html#tokenization) defines this
as a state machine with about eighty states, written out character by character. You start in the "data" state. A `<`
moves you to "tag open." A letter after that moves you to "tag name." And so on, with a named state for every situation
the messy reality of HTML can produce.

Python's `html.parser` does not implement this machine; it approximates it with regular expressions. That is faster to
write and good enough for tidy input, but it diverges from real browsers on malformed markup, and a regex cannot express
one thing the spec needs: the tokenizer's state sometimes depends on the tags it has already seen (inside `<script>`, a
`<b>` is text, not a tag). turbohtml implements the actual state machine, and it is checked against
[html5lib-tests](https://github.com/html5lib/html5lib-tests), the same conformance suite browsers use. Being correct and
being fast pull in different directions here, and most of the cleverness is in not letting correctness cost speed.

The dispatch loop is a plain `switch` over the current state, wrapped in a `for(;;)`:

```c
for (;;) {
    Py_UCS4 ch = read(self->pos);
    switch (self->state) {
    case ST_DATA:        /* ... */ continue;
    case ST_TAG_OPEN:    /* ... */ continue;
    case ST_TAG_NAME:    /* ... */ continue;
    // ~75 more
    }
}
```

The state enum is dense, so the compiler turns this into a [jump table](https://en.wikipedia.org/wiki/Branch_table): one
indirect jump per step. A transition is a store to `self->state` and a `continue`. Suspending the machine when the input
runs out is just leaving `self->state` alone and returning, which is what makes it resumable for streaming input. So far
this is a textbook tokenizer. Three things make it quick.

The easiest way to feel how the machine works is to step it. Type some markup and walk it one character at a time: watch
the current state light up, the cursor advance, and tokens pop out as tags and runs of text close. This widget models
the tag and attribute states faithfully (it simplifies character references, which the next section covers):

{{< tok-stepper text=`<p class="x">Hi & bye</p>` >}}

### Stamping the machine once per width

Here is that `str` storage detail I promised. Since [PEP 393](https://peps.python.org/pep-0393/), CPython stores every
string at the narrowest of three fixed widths, chosen by its largest character: one byte per character for Latin-1
(anything up to `U+00FF`), two bytes for the rest of the basic multilingual plane (up to `U+FFFF`), four bytes once an
astral character like an emoji appears (up to `U+10FFFF`). Type into the box below to watch a string land in one of the
three bins; add an accent or an emoji and see the whole string jump to a wider storage:

{{< width-picker text="café 🎉" >}}

A pure-ASCII document, which is most HTML, is one byte per character. Reading a character means indexing an array, and
the stride depends on the width. The naive way to handle all three is to branch on the width on every read. That branch,
on every character, is exactly the kind of cost we keep trying to avoid.

CPython solves this for its own string functions with a trick its source calls `stringlib`: write the algorithm once
against an abstract character type, then `#include` the file three times, redefining the type each time, to stamp out
three specialized copies. turbohtml does the same with its whole state machine. The core lives in a file
`tokenizer_sm_run.inc`, and it gets included three times:

```c
#define TH_CHAR  Py_UCS1                 // 1-byte build
#define TH_READ(i) ((Py_UCS4)((const TH_CHAR *)self->input.data)[(i)])
#include "tokenizer_sm_run.inc"
#undef  TH_CHAR
// ... again with Py_UCS2, again with Py_UCS4
```

Because `TH_CHAR` is a concrete type inside each copy, `TH_READ` compiles to a single indexed load with a fixed stride.
There is no width branch in the inner loop at all. The one runtime decision happens once, at the top, when the code
picks which of the three compiled machines to run:

```c
if (kind == PyUnicode_1BYTE_KIND) return run_ucs1(self);
if (kind == PyUnicode_2BYTE_KIND) return run_ucs2(self);
return run_ucs4(self);
```

You write the machine once and the compiler hands you three fast ones. For the one-byte case that dominates real
traffic, every read is plain byte arithmetic that the compiler is free to vectorize.

### Scanning text runs, not characters

A textbook state machine takes one step per character, even through a long paragraph of plain text where every character
does the same dull thing: append me to the current text run. That is a `switch`, a few comparisons, and some bookkeeping
per character, to copy bytes that needed no decisions.

[html5ever](https://github.com/servo/html5ever), the HTML parser in Servo, skips that. In the data state, when the
current character is ordinary text, it scans ahead to the next character that matters and moves the whole run in one
shot. turbohtml copies the approach. Only a few characters end a text run: `&` starts an entity, `<` starts a tag, and
`\n` needs line-counting. Everything else is just text. So the data state asks "where is the next of those?" and hands
over the entire span up to it:

```c
if (ch != '&' && ch != '<' && ch != '\n') {
    Py_ssize_t stop = scan_stops(self, self->pos + 1, '&', '<', '\n');
    text_append_run(self, stop);   // move the whole run at once
    continue;
}
```

And `scan_stops` is our friend from the escaping code: the same SIMD-or-SWAR block scan, now hunting for the first of
several stop characters instead of HTML specials. Sixteen bytes a step on ARM and x86, eight in the portable fallback.

```mermaid
flowchart LR
    D["data state<br/>at a text byte"] --> SC["scan_stops:<br/>SIMD find next<br/>& < or newline"]
    SC --> RUN["append the whole<br/>run in one move"]
    RUN --> STOP{"what stopped it?"}
    STOP -->|"&"| REF["entity"]
    STOP -->|"<"| TAG["tag"]
    STOP -->|"newline"| NL["count line, continue"]

    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef proc fill:#fde68a,stroke:#d97706,color:#0b1220;
    classDef dec fill:#ede9fe,stroke:#7c3aed,color:#0b1220;
    classDef good fill:#bbf7d0,stroke:#16a34a,color:#0b1220;
    class D data
    class SC,REF,TAG,NL proc
    class STOP dec
    class RUN good
```

A document that is mostly text, which describes most documents, gets processed at close to `memcpy` speed, with the
state machine waking up only at the tags.

### Never copy text you don't have to

There is one more level. When the machine moves a run of text, it does not copy the bytes. A run of plain text that came
straight from the input and was not modified is recorded as a pair of numbers, a start index and a length, pointing back
into the original string. turbohtml calls this a slice:

```c
// if this character is the next input byte, and contiguous
// with the slice we are already building, just extend the slice
if (ch == input[self->pos] &&
    self->pos == self->slice_start + self->slice_len) {
    self->slice_len++;     // no copy, just grow the window
    return;
}
```

The bytes get copied only when something forces it: an entity that decodes to a different character, a `\r\n` that needs
normalizing, a stray `<` that turned out to be text. Plain runs never materialize; the text token carries the indices,
and the actual `str` gets built lazily, with a single substring, only if the caller asks for the text.

It goes one step further for whole-document tokenizing. The spec asks a tokenizer to normalize newlines first, turning
every `\r\n` and lone `\r` into a single `\n`, and that rewrite is the one thing that forces the input to be copied.
Streaming `feed` does it in bulk anyway: it uses `memchr` to jump to the next `\r` and appends the whole run before it
in one move, so only the carriage returns themselves are handled character by character. But a document with no `\r` at
all needs no rewriting, so for the common one-shot case turbohtml checks for that and borrows the original string's
storage directly instead of copying the document in:

```c
if (PyUnicode_FindChar(arg, '\r', 0, length, 1) == -1) {
    th_tok_borrow_input(sm, kind, PyUnicode_DATA(arg), length);  // no copy at all
}
```

Put these together and trace a clean ASCII paragraph through the system. The input is borrowed, not copied. The text run
is a slice, a start and a length, not copied. The token carries those indices. Nothing in that paragraph gets copied
anywhere until you ask for its `.data`, and even then it is one substring. The data moves zero times on the way through.

### A token builds only what you ask for

The state machine emits a plain C record. The `Token` you get back is a thin wrapper that copies that record, since the
machine reuses its record storage for the next token, and then does as little as it can. None of the Python-visible
values exist yet. Ask for `token.type` and you get back a cached enum member with one reference bump; the five
`TokenType` members are built once when the module loads and kept in module state, so reading a type never does a
lookup. Ask for `token.tag` or `token.attrs` and only then does turbohtml build the string or the list. A consumer that
scans a document to count its start tags never builds a single attribute string. The same laziness keeps attribute
lookup cheap: `token.attr("href")` walks the record's C array and compares bytes in place, returning the one value you
asked for without building a dict.

When the token does copy the record, it picks the cheapest of three strategies for where to put the bytes:

```mermaid
flowchart TD
    R["emitted record"] --> Q1{"an untouched<br/>input slice?"}
    Q1 -->|yes| S["keep (start, length),<br/>build a str on demand"]
    Q1 -->|no| Q2{"a text run<br/>over 512 chars?"}
    Q2 -->|yes| M["steal the machine's buffer<br/>(swap pointers, no copy)"]
    Q2 -->|no| A["pack every piece into<br/>one arena allocation"]

    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef dec fill:#ede9fe,stroke:#7c3aed,color:#0b1220;
    classDef good fill:#bbf7d0,stroke:#16a34a,color:#0b1220;
    classDef proc fill:#fde68a,stroke:#d97706,color:#0b1220;
    class R data
    class Q1,Q2 dec
    class S,M good
    class A proc
```

The first branch is the zero-copy slice from above. The second handles a large block of text: rather than duplicate a
long run, the token takes the machine's text buffer outright by swapping pointers, and the machine grows a fresh one for
the next run. The third, the default for tags and short tokens, is the arena.

### One allocation per token, not a dozen

Take that third branch, a tag with attributes. It has to hand the caller a tag name, and for each attribute a name and a
value, plus the odd comment or doctype with a public and system identifier. These are variable-length pieces, so the
obvious way to store them is one `malloc` each. A tag with five attributes works out to roughly a dozen small
allocations, and a matching dozen `free` calls when the token is thrown away.

That is wasteful for two reasons. The first is that `malloc` and `free` are not cheap when you call them this often:
each one walks a free list, updates the allocator's bookkeeping, and on a free-threaded build takes a lock. Spending a
dozen of them on a single token, millions of times, adds up. The second is locality. Twelve separate allocations land in
twelve scattered spots on the heap, so reading the token back later chases pointers through cache-cold memory.

turbohtml uses an arena instead. The idea is to make one big allocation and carve all the pieces out of it by hand. It
takes two quick passes over the token's parts. The first pass adds up how many bytes everything needs, rounding each
piece up so the next one starts on an aligned boundary (wide UCS-2 or UCS-4 text has to sit at an even or four-aligned
address). The second pass does a single `malloc` of that total and then walks a cursor through the block, copying each
piece in and handing back a pointer to where it landed:

```c
// pass 1: total the sizes, with alignment padding between pieces
size_t total = sizeof(Token);
total += padded(name.len) + padded(text.len);
for (each attribute a) total += padded(a.name.len) + padded(a.value.len);

// one allocation for the whole token
char *arena  = PyMem_Malloc(total);
char *cursor = arena + sizeof(Token);

// pass 2: bump the cursor, point each field into the block
name_ptr = cursor;  memcpy(cursor, name.data, name.len);  cursor += padded(name.len);
text_ptr = cursor;  memcpy(cursor, text.data, text.len);  cursor += padded(text.len);
// ... and so on for every attribute name and value
```

The whole token, header and tag name and every attribute, is now one contiguous block of memory:

```mermaid
flowchart LR
    subgraph A["one PyMem_Malloc, one PyMem_Free"]
      direction LR
      H["header"] --- NM["name"] --- TX["text"] --- A0N["attr0<br/>name"] --- A0V["attr0<br/>value"] --- A1N["attr1<br/>name"] --- A1V["attr1<br/>value"]
    end

    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef proc fill:#fde68a,stroke:#d97706,color:#0b1220;
    class H data
    class NM,TX,A0N,A0V,A1N,A1V proc
    style A fill:none,stroke:#16a34a,stroke-width:2px,color:#16a34a
```

This helps in three ways. A token costs one `malloc` and one `free` no matter how many attributes it carries, instead of
one per field. The bytes sit next to each other, so reading the token touches one cache line region rather than a dozen
scattered ones. And freeing is a single `free` of the base pointer, with no per-field cleanup to get wrong and no way to
leak one piece while releasing the rest. It is the same instinct as the rest of the library, do the bookkeeping once up
front so the common path stays cheap.

### Small things that add up

A few more touches keep the inner loop lean, none of them dramatic on their own:

- **Buffers are reused, not freed.** Between tokens, the growable buffers for tag names and text reset their length to
  zero and keep their memory. After the first few tokens the machine stops allocating and just refills the same space.
  When a buffer does grow, it doubles, so appends are amortized constant time.
- **Tokens hold no Python references**, so they sit outside the
  [garbage collector](https://github.com/python/cpython/blob/main/InternalDocs/garbage_collector.md). The most
  frequently created object in the system never gets tracked or traversed.
- **The line and column counters update without a branch.** A newline test becomes a `0` or `1` that is added to the
  line count and used to reset the column, so the per-character bookkeeping carries no jump.
- **Tag names are lowercased on the way in**, so every later comparison works on already-folded text. Deciding whether
  `<script>` switches the tokenizer into raw-text mode is then a chain of
  [`memcmp`](https://en.cppreference.com/w/c/string/byte/memcmp) calls against string literals, with the literal lengths
  taken at compile time so there is no runtime `strlen`. Checking whether an end tag matches the open raw-text element
  is a length comparison, a width comparison, and one `memcmp`, never a character loop.
- **Error handling stays off the hot path.** A failed allocation sets one sticky `oom` flag that is checked once per
  token rather than after every append, so the per-character code carries no error branch.
- **Duplicate attributes are dropped lazily.** The spec keeps the first occurrence of a repeated attribute name; rather
  than maintain a set while tokenizing, turbohtml resolves that only when you read `token.attrs`, scanning the few
  attributes a real tag has.
- **The pending-token queue is two slots.** The only time the machine emits two tokens at once is when a text run ends
  and the tag that ended it follows, so a fixed two-entry ring is all it needs, with no dynamic queue to allocate.

None of these would matter alone. Together they mean a steady stream of tokens runs with almost no allocation and no
garbage-collector overhead.

## What it all adds up to

Step back and the techniques rhyme. Escaping, unescaping, and tokenizing are different problems, but the fast versions
all do the same four things:

1. **Scan in blocks, not characters.** SWAR checks eight bytes with a subtraction; SIMD checks sixteen with a shuffle.
   The common case, a clean block, costs almost nothing to clear.
2. **Skip to the next interesting byte and bulk-copy the rest.** Whether the needle is a special character, an `&`, or a
   tag opener, the long boring spans between them move at `memcpy` speed and never get inspected per character.
3. **Keep text at its native width and copy it as few times as possible.** An ASCII document stays one byte per
   character from input to output, and a clean run of text is often never copied at all.
4. **Decide once, not per character.** Pick the storage width once, size the output once, choose the compiled machine
   once, and the inner loop stays branch-light.

For an ordinary ASCII web page, the path through turbohtml is: borrow the input, scan it sixteen bytes at a step, emit
text tokens that are just offsets into the original, and build a `str` only when asked. The bytes barely move. That is
where the speed comes from, and as far as I can tell none of it is magic, just a handful of old ideas stacked on top of
each other.

## The rest of the library learned the same lessons

Everything above is the original three functions: escape, unescape, tokenize. turbohtml did not stay there. It grew a
tree builder, a CSS and XPath query engine, a serializer, a sanitizer, an HTML and CSS and JavaScript minifier, metadata
extraction, and a URL parser, all with the same C core underneath. The interesting part is that the four principles kept
paying off, and the places they did not reach needed a different idea. Here are the ones worth knowing.

Before the techniques, here is the shape of the whole toolkit against the libraries people reach for, one representative
input each. turbohtml is the green column; the parenthetical is the competitor's time against turbohtml's, so above one
is slower and below one is faster. The full picture, every operation against every competitor, lives in the
[migration guides](https://turbohtml.readthedocs.io/migration/index.html).

{{< bench-table you=2 nums="3,4" >}} operation | input | turbohtml | a fast peer | a popular peer ; parse | 92 kB page |
272 µs | resiliparse 282 µs (1.0x) | BeautifulSoup 15.3 ms (56x) ; query (CSS select) | 95 kB page | 1.3 µs | lxml 20.8
µs (16x) | BeautifulSoup 99.9 µs (77x) ; tokenize | typical markup | 34.9 µs | html.parser 435 µs (12x) | html5lib 836
µs (24x) ; escape | dense 4 MiB | 4.98 ms | html.escape 12.7 ms (2.6x) | n/a ; unescape | dense refs (4 KiB) | 8.1 µs |
html.unescape 69.3 µs (8.6x) | w3lib 116 µs (14x) ; minify HTML | 95 kB page | 331 µs | minify-html 859 µs (2.6x) |
htmlmin 6.77 ms (20x) ; minify CSS | bootstrap 274 kB | 229 kB in 1.65 ms | rcssmin 233 kB in 625 µs (0.4x) |
lightningcss 229 kB in 4.82 ms (2.9x) ; minify JS | jquery 279 kB | 88 kB in 9.73 ms | rjsmin 141 kB in 335 µs (0.0x) |
terser 87 kB in 122 ms (12x) ; sanitize | 4 KiB post | 42.1 µs | nh3 120 µs (2.9x) | bleach 1.92 ms (46x)
{{< /bench-table >}}

Two things the table makes concrete. Minification trades speed against size, which is why the minify rows carry both.
The regex minifiers [`rcssmin`](https://pypi.org/project/rcssmin/) and [`rjsmin`](https://pypi.org/project/rjsmin/) are
the fastest tools by a wide margin, but the size columns show they leave the file bigger; the full parsers
[lightningcss](https://lightningcss.dev/) and [terser](https://github.com/terser/terser) match turbohtml's compression
and pay several times the time for it; turbohtml sits at both corners at once. And
[resiliparse](https://github.com/chatnoir-eu/chatnoir-resiliparse) ties turbohtml on parse because it too is a
hand-written C parser. The point is not that turbohtml wins every row. It is that a fully typed, spec-conformant toolkit
sits in the same class as the fastest native code, an order of magnitude ahead of the pure-Python libraries most
projects run.

### Interning names to integers

A parser compares tag names constantly. Is this a `<script>`? Does this end tag close the open `<p>`? Does the selector
`div.note` match this element? Done as written, each of those is a string comparison, and a string comparison walks
bytes.

turbohtml almost never compares tag-name bytes after the tokenizer. Every tag and attribute name in the HTML namespace
has a fixed small integer, its _atom_, assigned when the name is first seen. The tokenizer already lowercases names on
the way in, the step I described earlier, so folding a name to its atom is a lookup, and after that a tag is an integer.
Deciding whether an element is a `<div>` is `node->atom == TH_TAG_DIV`, one comparison, no memory touched past the node
itself. The exception is a name outside the known table: those share a single `TH_TAG_UNKNOWN` atom and fall back to a
byte compare, rare enough not to matter.

That one integer compare shows up everywhere the query engine walks the tree. When `find_all("a")` looks for anchors, it
does not test every descendant; the tree carries a per-tag index, and the search visits only the
[pre-order](https://en.wikipedia.org/wiki/Tree_traversal) bucket of `a` elements. When the same call adds an attribute
filter, `find_all("a", attrs={"href": True})`, the tag still selects the bucket and the filter runs only over those
candidates:

```c
static int tag_plain_matches(const query_t *query, th_node *node) {
    if (query->tag_atom != TH_TAG_UNKNOWN) {
        return node->atom == query->tag_atom;   // a known tag: one integer compare
    }
    // an unknown-name query can only match the rare unknown-atom elements
    return node->atom == TH_TAG_UNKNOWN ? tag_matches_by_name(query, node) : 0;
}
```

```mermaid
flowchart LR
    Q["find_all('a', href=True)"] --> A["fold 'a' to its atom<br/>TH_TAG_A"]
    A --> B["per-tag index:<br/>the bucket of &lt;a&gt; nodes"]
    B --> F["test href on the<br/>bucket only"]
    F --> R["matches"]
    T["every descendant<br/>of the tree"] -. skipped .-> R
    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef proc fill:#fde68a,stroke:#d97706,color:#0b1220;
    classDef good fill:#bbf7d0,stroke:#16a34a,color:#0b1220;
    classDef bad fill:#fecaca,stroke:#dc2626,color:#0b1220;
    class Q,A data
    class B,F proc
    class R good
    class T bad
```

The bucket, not the cheaper compare, is what produces the large numbers: it lets the search visit only the tag's
elements and skip the rest of the tree, while the one-compare match keeps each candidate it does reach cheap on top.
`find_all("a", attrs={"href": True})` over the WHATWG spec drops from 33.5 to 4.4 microseconds, and a rare-tag lookup
like `find_all("meta", attrs={"name": "viewport"})` from 29.2 down to 0.17. The same integer compare rides into the CSS
engine, which matches selectors right to left. A selector like `section > p` anchors on each `p` and checks its parent;
when the left side of a combinator is a bare type selector, that step is `parent->atom == TH_TAG_SECTION` before the
full compound matcher runs. Selector matching picks up 11 to 19 percent across the corpus pages. This is the same trick
browsers use: an [interned name](https://en.wikipedia.org/wiki/String_interning), sometimes called an atom or a quark,
so that the hot comparison is an integer identity test. It is the string-side equivalent of everything the tokenizer
does to avoid touching bytes it does not need.

{{< atom-index >}}

### Building the index once instead of every time

`element.css_path()` hands back a CSS selector that locates one element from the document root, the thing your browser's
devtools shows when you right-click and copy a selector. The short selector is an id, `#main > p:nth-of-type(3)`, but a
selector may anchor on an id only if that id is unique in the document, because a repeated id would match more than one
element and the path would be wrong.

The first version checked uniqueness the obvious way: to see whether an id was unique, scan the whole document and count
how many elements carried it. That is O(N) per candidate, and pathing every element in a document is then O(N squared).
On a document with six thousand ids it took 112 milliseconds, which is slow enough to notice.

The fix is an auxiliary index built once. The first `css_path()` call on a tree builds an id-occurrence map, an
[open-addressed hash table](https://en.wikipedia.org/wiki/Open_addressing) from id value to the count of elements
carrying it, and caches it on the tree. Uniqueness is then a probe of a few characters instead of a document scan:

```c
static uint64_t path_id_hash(const Py_UCS4 *value, Py_ssize_t len, int ci) {
    uint64_t hash = 14695981039346656037u;          // FNV-1a
    for (Py_ssize_t i = 0; i < len; i++) {
        hash ^= (uint64_t)sel_fold(value[i], ci);   // fold case in quirks mode, as the id selector does
        hash *= 1099511628211u;
    }
    return hash;
}

// unique means the map counted exactly one element with this id
static int path_id_unique(const path_id_map *map, const Py_UCS4 *value, Py_ssize_t len) {
    size_t slot = (size_t)path_id_hash(value, len, map->ci) & map->mask;
    while (!sel_eq(map->slots[slot].value, map->slots[slot].len, value, len, map->ci)) {
        slot = (slot + 1) & map->mask;              // linear probe past collisions
    }
    return map->slots[slot].count == 1;
}
```

```mermaid
flowchart TB
    C["css_path anchors on an id"] --> W{"is the id unique?"}
    W --> NAIVE["naive: scan the whole document<br/>and count it, O(N) per id,<br/>O(N²) to path every element"]
    W --> INDEX["indexed: build an id→count map<br/>once, then probe it,<br/>O(id length) per id"]
    NAIVE --> R1["112 ms on 6002 ids"]
    INDEX --> R2["0.9 ms, about 125x"]
    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef dec fill:#ede9fe,stroke:#7c3aed,color:#0b1220;
    classDef good fill:#bbf7d0,stroke:#16a34a,color:#0b1220;
    classDef bad fill:#fecaca,stroke:#dc2626,color:#0b1220;
    class C data
    class W dec
    class NAIVE,R1 bad
    class INDEX,R2 good
```

The probe terminates without a bounds check because the candidate's own id is always in the map, so the walk always
lands on a filled slot: a `count` of one means the element owns its id alone. The map is cached on the tree and thrown
away the moment the tree mutates, together with the element index it sits beside, so a stale count can never anchor a
path on an id that a later edit duplicated. Building an index once and dropping it on write is the standard shape of
this kind of cache, and it is worth reaching for whenever a per-item check secretly rescans the whole collection. The
six-thousand-id document went from 112 milliseconds to 0.9, and `css_path` now runs about five times faster than
libxml2's `getpath` where it used to trail.

{{< id-locator >}}

### Recycling the wrapper objects

Every node a query returns is a Python object wrapping a C tree node. A `find_all` over a large page builds thousands of
them, and they die as soon as the caller is done iterating. Allocating and freeing a Python object is not free: it walks
the allocator's [free list](https://en.wikipedia.org/wiki/Free_list), and on a free-threaded build it takes a lock.

I noted earlier that the tokenizer reuses its buffers rather than freeing them. The query layer does the same for whole
objects, with a small free list. When a node wrapper is deallocated it is parked on the list instead of released, and
the next wrap revives it:

```c
static void node_dealloc(PyObject *self) {
    Py_DECREF(((NodeObject *)self)->handle);
    if (state->node_freelist_len < NODE_FREELIST_MAX) {         // park it, do not free it
        ((NodeObject *)self)->node = (th_node *)state->node_freelist;  // next link rides in the node field
        state->node_freelist = self;
        state->node_freelist_len++;
        Py_DECREF(Py_TYPE(self));    // PyObject_Init re-takes the type ref on revive
        return;
    }
    Py_TYPE(self)->tp_free(self);
}
```

```mermaid
flowchart LR
    WR["node_wrap()"] --> Q{"free list<br/>has one?"}
    Q -->|yes| RV["revive:<br/>PyObject_Init"]
    Q -->|no| AL["tp_alloc"]
    RV --> U["live wrapper"]
    AL --> U
    U --> DE["dealloc"]
    DE --> QC{"pool full?"}
    QC -->|no| PK["park it: next link<br/>rides in the node field"]
    QC -->|yes| FR["free"]
    PK --> Q
    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef proc fill:#fde68a,stroke:#d97706,color:#0b1220;
    classDef dec fill:#ede9fe,stroke:#7c3aed,color:#0b1220;
    classDef good fill:#bbf7d0,stroke:#16a34a,color:#0b1220;
    class WR,U data
    class RV,AL,PK proc
    class Q,QC dec
    class FR good
```

Two details make it cheap. The list is [_intrusive_](https://www.boost.org/doc/libs/release/doc/html/intrusive.html):
the next-pointer rides inside the `node` field the parked object no longer needs, so the pool costs no extra storage.
And one list serves every node type, because a `NodeObject` is a fixed 32 bytes whatever it wraps (the real payload
lives in the C tree) and the concrete types the wrapper stamps, Element, Text, Comment and the rest, none accept a
[subclass](https://docs.python.org/3/c-api/typeobj.html#c.Py_TPFLAGS_BASETYPE) or add a field (only the abstract base
`Node` is subclassable, and it is never instantiated), so reviving one with
[`PyObject_Init`](https://docs.python.org/3/c-api/allocation.html#c.PyObject_Init) and re-stamping its type is always
sound. The list is capped at 1024 entries, about 32 KiB, so a burst of queries recycles freely without pinning memory
afterward. On a 92 kB page, `find_all()` drops from 1.9 to 1.4 microseconds and a full descendant walk from 101 to 65,
moving the lead over lxml from 2.9x to 4.3x. Where it does not help is holding every wrapper alive at once,
`list(doc.descendants)`, where nothing is ever returned to recycle; that path is about 8 percent slower, a fair trade
for the common one being faster.

The pool exists only on the default build. The free-threaded build keeps the plain allocate-and-free path, because a
shared list is safe only because the GIL serializes access to it, and that is the guarantee the free-threaded build
removes. The section on free-threading below is the longer version of that argument.

{{< node-pool >}}

## When the work is a standard, not a scan

The URL parser is where the block-scanning story runs out. Splitting a URL into its parts, percent-encoding a path,
resolving a relative reference against a base: all of these moved into C and got several times faster, but the speedup
is the plain one, no interpreter in the loop, the same reason the first C accelerator was faster than pure Python. The
scanning tricks do not apply, and one of them runs backward: the URL code deliberately widens the whole input to
four-byte characters up front, so the rest of the code reads one fixed width instead of branching on width per read.
That is the opposite of the tokenizer, which refuses to widen and compiles three machines so an ASCII document stays one
byte per character. The difference is size. A URL is short, so widening it once costs nothing and buys a simpler loop; a
document is large, so widening it would be the 4x copy the tokenizer bends over backward to avoid. Different input,
different answer.

Host encoding is the exception, and it is worth a section because it is a kind of work the rest of the library does not
do. Turning `café.example` into the ASCII `xn--caf-dma.example` that DNS can carry is
[Internationalized Domain Names](https://www.rfc-editor.org/rfc/rfc5890) (IDNA), and doing it the way the
[WHATWG URL Standard](https://url.spec.whatwg.org/#idna) asks means [UTS #46](https://www.unicode.org/reports/tr46/)
`ToASCII`, which pulls in three separate pieces of Unicode machinery. Python's `str.encode("idna")` implements an older
version of the standard and gets several cases wrong (`faß.de` should become `xn--fa-hia.de`, not `fass.de`), so
turbohtml implements the current one from scratch in C. That meant writing three things nothing else in this piece
needed:

- [**Punycode**](https://www.rfc-editor.org/rfc/rfc3492), the encoding that packs `café` into `caf-dma`. It is a
  bootstring algorithm: a run of generalized variable-length integers with an adaptive bias, unlike anything else in the
  library, and a fun one to implement against the RFC's reference pseudocode.
- [**Normalization Form C**](https://www.unicode.org/reports/tr15/), because `é` can arrive as one code point or as `e`
  plus a combining accent, and they have to encode identically. Composing them means canonical decomposition, a stable
  sort of [combining marks by class](https://www.unicode.org/reports/tr44/#Canonical_Combining_Class), then
  recomposition, reimplemented rather than borrowed from `unicodedata`.
- **Hangul by arithmetic.** Korean syllables compose and decompose by a
  [formula](https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-3/) rather than a table, so all 11,172
  precomposed syllables cost zero table rows. It is the cleanest example I know of picking an algorithm over a lookup.

```mermaid
flowchart LR
    H["café.example<br/>Unicode host"] --> M["UTS #46 map<br/>keep / map / drop"]
    M --> N["normalize to NFC"]
    N --> P["Punycode each label<br/>RFC 3492"]
    P --> A["xn--caf-dma.example<br/>ASCII for DNS"]
    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef proc fill:#fde68a,stroke:#d97706,color:#0b1220;
    classDef good fill:#bbf7d0,stroke:#16a34a,color:#0b1220;
    class H data
    class M,N,P proc
    class A good
```

The mapping data that is left, which code points UTS #46 keeps, maps, or drops, is 6,960 ranges stored as
`{first, last, status, offset, length}` rows and probed by binary search: the range says what happens to a code point,
and a mapped range points at the replacement in a shared pool with the `offset` and `length`. It is a different
structure from the direct-index tables the escaping code uses, because the key space is all of Unicode and mostly empty.

The part I would not have guessed in advance is that most of this code is generated. A
[331-line build script](https://github.com/tox-dev/turbohtml/blob/main/tools/generate_idna.py) downloads the pinned
[Unicode 16.0.0 database](https://www.unicode.org/Public/16.0.0/ucd/) and writes an 8,513-line C header: the mapping
ranges, the combining classes, and the decompositions already expanded recursively so the C runtime never recurses. It
is pinned to the exact Unicode version CPython 3.14's `unicodedata` ships, so the hand-written C normalizer and the
interpreter always agree on the answer. Generating a spec's data tables at build time, pinned for reproducibility, is
its own technique, and a better one than transcribing five thousand table rows by hand and hoping. The lesson that
carried over from the scanning work was the smaller one: do the expensive preparation once, at build time here rather
than in the first pass, so the runtime stays simple.

{{< idna-encode >}}

## Teaching the compiler what is hot

Everything so far is source-level. Two build-level techniques squeeze the same code further, and both come with a catch
worth explaining.

The first is [link-time optimization](https://gcc.gnu.org/onlinedocs/gccint/LTO-Overview.html) (LTO). As the query
engine grew, one source file had swollen past 4,200 lines, accreting the select, regex, and xpath entry points, because
splitting anything out of it would have cost speed: the compiler can only inline across a function-call boundary when
both sides sit in the same [translation unit](<https://en.wikipedia.org/wiki/Translation_unit_(programming)>), and the
query code leaned on calls into the tree code being inlined. Pulling the hot CSS selector engine into its own file costs
about 9 percent on `select` under gcc for exactly that reason. LTO buys it back. With LTO the compiler defers
optimization to link time, when it can see the whole program at once and
[re-inline across the file boundary](http://hubicka.blogspot.com/2014/04/linktime-optimization-in-gcc-1-brief.html) it
just split, landing within 0.1 percent of the monolith. So LTO landed first and the split followed, in that order,
because the split is only free once LTO is there to undo its cost. The related move is telling the compiler which code
is cold: the long bulk-text scan in the tokenizer is marked
[`noinline`](https://gcc.gnu.org/onlinedocs/gcc/Common-Function-Attributes.html) and pulled out of line, so the compact
markup-heavy path that runs far more often stays small and stays in cache.

The second is [profile-guided optimization](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html) (PGO), and it buys
more than LTO does. The build runs in two phases. First it compiles an instrumented binary, runs it over a training
workload while it records which branches are taken and which functions are hot, then recompiles using that profile to
lay out the code the way the run used it. CPython builds itself this way, and the standard advice holds: the gain is
only as good as the training workload is representative. Measured against a plain `-O3` build with
[cachegrind](https://valgrind.org/docs/manual/cg-manual.html), PGO cut instructions by 15.7 percent on parse, 27.5 on
select, and 13.2 on serialize.

```mermaid
flowchart LR
    S["source"] --> I["build instrumented<br/>-Db_pgo=generate"]
    I --> TR["train on a<br/>representative corpus"]
    TR --> U["rebuild with the profile<br/>-Db_pgo=use"]
    U --> V{"held-out check:<br/>net gain, no op<br/>regresses past 2%?"}
    V -->|yes| SHIP["ship the wheel"]
    V -->|no| REJ["reject: overfit"]
    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef proc fill:#fde68a,stroke:#d97706,color:#0b1220;
    classDef dec fill:#ede9fe,stroke:#7c3aed,color:#0b1220;
    classDef good fill:#bbf7d0,stroke:#16a34a,color:#0b1220;
    classDef bad fill:#fecaca,stroke:#dc2626,color:#0b1220;
    class S data
    class I,TR,U proc
    class V dec
    class SHIP good
    class REJ bad
```

Getting there took two rounds of learning what "representative" means. The first training corpus was one clean UTF-8
document, so the profile never saw the messy branches: the
[adoption-agency algorithm](https://html.spec.whatwg.org/multipage/parsing.html#adoptionAgency), foreign-content
breakout, legacy encodings, tag soup. The corpus now spans those branch classes on purpose, mixing clean markup with
deliberately broken fixtures from the [html5lib test suite](https://github.com/html5lib/html5lib-tests) and real saved
pages. Representativeness is code-path coverage, not input volume.

The subtler bug was in how the training run spent its time. It first ran every operation a flat eight times, which
sounds fair and is not. A whole-document parse runs orders of magnitude more instructions per call than a read-path
query like `text-content`, so under a flat count the cheap operation's hot blocks landed below the profile's global hot
cutoff, the compiler read them as cold, and their layout flipped a few percent between rebuilds. That was a phantom
regression that kept tripping the benchmark gate. The fix is to budget by time, not by iterations: give every operation
an equal slice of wall-clock, so a cheap operation repeats into the thousands and clears the hot cutoff decisively. This
is a real pitfall of PGO that the textbook description skips, and it took a flaky CI signal to find.

One guard makes the whole thing trustworthy. PGO's failure mode is overfitting, laying out the code for the training
inputs at the expense of everything else, and the way to catch it is a held-out set. A validation step measures a third
group of pages that appear in neither the training corpus nor the benchmark suite, and the build passes only on a net
gain with no single operation regressing past 2 percent, which is the signature of an overfit profile. On the held-out
pages the real gain is 13.9 percent [geometric mean](https://en.wikipedia.org/wiki/Geometric_mean), below the 15-to-27
percent that parse and select showed on the training inputs, because those were measured on the very data the profile
trained on, which is measuring your own homework.

## Measuring comes before improving

You cannot improve what you cannot measure, and none of the numbers in this article would mean much without a suite
built to produce them honestly. The measurement setup is as much a part of the project as the C, so it is worth a look.

Every published speedup comes from `tox -e bench`, which times each operation with
[pyperf](https://pyperf.readthedocs.io) on a quiet, tuned machine (`pyperf system tune` first, with `--rigorous` and CPU
pinning available). pyperf runs each case in isolated worker processes, calibrates the loop count, warms up, and reports
a mean with a relative standard deviation, so every figure carries its own noise estimate. An operation that mutates the
tree gets special handling: the tree is rebuilt untimed before each iteration, because timing the second mutation of an
already-mutated tree measures neither the real work nor anything stable.

The corpus is chosen for code-path coverage, not size. Clean layout markup comes from the WHATWG and ECMAScript specs
and the [web-platform-test](https://github.com/web-platform-tests/wpt) fixtures; the nested divs and links that
selectors and `:has()` actually chase come from real saved pages in Mozilla's
[readability](https://github.com/mozilla/readability) corpus; recovery paths come from deliberately broken
[html5lib fixtures](https://github.com/html5lib/html5lib-tests) that fire the adoption-agency and foster-parenting
algorithms; escaping and unescaping run over Tolstoy's [_War and Peace_](https://www.gutenberg.org/ebooks/2600);
encoding detection runs over prose re-encoded into [Shift-JIS](https://en.wikipedia.org/wiki/Shift_JIS),
[GBK](<https://en.wikipedia.org/wiki/GBK_(character_encoding)>), and the Windows codepages; and CSS and JavaScript
minification climb a size ladder from a 6 kB reset to a 745 kB framework. Every branch that matters gets exercised by
something real.

The comparison is against 59 other libraries, from lxml and BeautifulSoup to selectolax, minify-html, nh3, trafilatura,
and courlan, and each one runs in its own [uv](https://docs.astral.sh/uv/) virtual environment holding only that
library. The harness never imports a competitor; it reads each one's requirements out of the source with the
[`ast`](https://docs.python.org/3/library/ast.html) module, so one library's dependency pins can never perturb
another's, and every library sees the identical input for a like-for-like ratio. A library that fails to install drops
its column with a note; one that installs and then crashes fails the run, because that is a real result, not an
environment quirk.

That suite feeds two consumers, and the split is the whole point. The wall-clock timings are the human-facing answer to
how fast, so they run on a tuned machine and never in CI, where wall-clock is the noise the next section is about. The
same operation registry also drives a Callgrind instruction-count gate on every pull request, a reproducible regression
alarm a wall-clock bench could never be. Instruction counts catch the small regression wall-clock is too jittery to see;
wall-clock measures the real speed an instruction count cannot express. Neither on its own is enough.

## Measuring without lying to yourself

The benchmark numbers in this article are only worth printing if they are stable, and a benchmark that runs in CI is
fighting a losing battle for stability. Shared runners have neighbors, frequencies scale, and the same benchmark can
read
[as much as 50 percent apart from one run to the next on cloud CI](https://pythonspeed.com/articles/consistent-benchmarking-in-ci/)
with nothing changed. A wall-clock regression alarm in that environment cries wolf until you stop believing it, which is
worse than having no alarm.

The way out is to stop measuring time. [CodSpeed](https://codspeed.io/) runs each benchmark under
[Callgrind](https://valgrind.org/docs/manual/cl-manual.html), which executes the code on a simulated CPU and counts the
instructions it runs. An instruction count does not care how busy the runner is; the same code produces the same count
to well under one percent, so a real change stands out from the noise instead of drowning in it. The cost is that the
simulator's cache and branch predictor are idealized models rather than the runner's real silicon, so the count is a
proxy for time rather than time itself, but for catching a regression on a pull request a stable proxy beats a true
measurement you cannot trust.

Making the count reproducible took chasing down two sources of drift, and both are instructive because neither is
obviously a benchmarking problem. The first is PGO itself. A fresh profile is collected on every CI run, and it is not
byte-identical from one run to the next, so the hot-path layout shifts and a marginal operation swings a few percent for
no source reason. The fix is to measure a different binary than you ship: the benchmark gate builds with LTO only, which
is reproducible, while the wheels you download keep the full PGO profile. The measured binary and the shipped binary are
not the same, and that is the point.

The second is the C library, and it is the article's own SIMD tricks turned against it. GitHub hands the job whatever
CPU is free, an Intel Xeon with [AVX-512](https://en.wikipedia.org/wiki/AVX-512) one run and an AMD EPYC without it the
next, and
[glibc dispatches a different vectorized `memcpy` and `memmove` per CPU](https://sourceware.org/glibc/wiki/Tunables).
The same source then runs a different number of instructions depending on which `memcpy` the hardware selected, so
untouched benchmarks drift a few percent between the base run and the pull-request run, wide enough to bury a small real
regression. Pinning `GLIBC_TUNABLES` to switch off the newer AVX and fast-string paths that differ across those CPUs
forces every runner down to the SSE2 baseline glibc always has, and the count reproduces. That baseline is slower and,
since it moves fewer bytes per instruction than the AVX copy it replaces, it even raises the absolute count, but it
costs the gate nothing: the tunable is set only for the CI measurement, never for the wheels you install, and the gate
compares a base run against a pull-request run with both pinned to the same path, so a higher-but-reproducible count
shifts them together and hides no regression.

```mermaid
flowchart TB
    C["the same source"] --> X["Intel Xeon runner:<br/>AVX-512 memcpy"]
    C --> Y["AMD EPYC runner:<br/>SSE2 memcpy"]
    X --> D1["instruction count N1"]
    Y --> D2["instruction count N2 ≠ N1"]
    D1 --> WB["a few percent drift<br/>hides small regressions"]
    D2 --> WB
    PIN["pin GLIBC_TUNABLES:<br/>SSE2 on every runner"] --> D3["one count, reproducible"]
    classDef data fill:#dbeafe,stroke:#2563eb,color:#0b1220;
    classDef proc fill:#fde68a,stroke:#d97706,color:#0b1220;
    classDef bad fill:#fecaca,stroke:#dc2626,color:#0b1220;
    classDef good fill:#bbf7d0,stroke:#16a34a,color:#0b1220;
    class C data
    class X,Y,PIN proc
    class D1,D2,WB bad
    class D3 good
```

{{< bench-determinism >}}

Both fixes buy the same thing, an instruction count a real regression can move on its own instead of one that already
wobbles for reasons unrelated to the code. There is a limit worth naming: this gate measures a reproducible LTO-only
build, so it catches source-level regressions, which show up in the shipped PGO build too, but a regression that lived
only in the PGO code layout would slip past it. That is the price of measuring a stable binary instead of the exact one
you ship, and a trade I would make again over an alarm nobody believes.

Reporting what the numbers really say means owning the experiments that went nowhere, too. Fusing the
metadata-extraction walks into one tree pass moved it a few percent at most, because parsing and property extraction
dominate that path and the walks were already cheap. And a bottom-up rewrite of the `:has()` selector, which is still
quadratic on deeply nested trees, wants a scratch field on every node that the 80-byte node struct has no room for, so
it stays on the list. The honest state of the code is that `:has()` on a pathological tree can still blow up, and I have
not fixed it yet.

## Making it free-threaded

Speed is one half of why I wrote this now. The other half is that Python is in the middle of removing the
[global interpreter lock](https://docs.python.org/3/glossary.html#term-global-interpreter-lock), the lock that lets only
one thread run Python bytecode at a time. [PEP 703](https://peps.python.org/pep-0703/) added a build of CPython with the
GIL switched off; it
[shipped experimentally in 3.13](https://docs.python.org/3/whatsnew/3.13.html#free-threaded-cpython) and became
[officially supported in 3.14](https://docs.python.org/3.14/whatsnew/3.14.html) once
[PEP 779](https://peps.python.org/pep-0779/) signed off on it. On that build, threads run Python in parallel across
every core, and code that quietly leaned on the GIL for safety stops being safe. I have written more about that rollout
in my [PyTexas 2026 recap](/posts/pytexas-2026-recap), and about how to test threaded code for the races it surfaces in
[Deterministic Multithreaded Testing with blanket](/posts/blanket-deterministic-threading).

A C extension is exactly the kind of code that might have leaned on it. So the free-threaded build refuses to trust an
extension unless the extension says it is ready, and the
[rule is blunt](https://docs.python.org/3/howto/free-threading-extensions.html): if a module does not declare that it is
safe without the GIL, importing it on a free-threaded interpreter prints a warning and switches the GIL back on for the
whole process. One unprepared extension and every thread loses the parallelism.

Declaring readiness is one slot in the module definition. turbohtml uses
[multi-phase initialization](https://peps.python.org/pep-0489/), the modern module setup that also makes per-module
state and sub-interpreters work, and hangs two slots off it:

```c
static PyModuleDef_Slot html_slots[] = {
    {Py_mod_exec, html_exec},
    {Py_mod_multiple_interpreters, Py_MOD_PER_INTERPRETER_GIL_SUPPORTED},  // ok in per-interpreter-GIL subinterpreters
    {Py_mod_gil, Py_MOD_GIL_NOT_USED},                                     // safe with the GIL off
    {0, NULL},
};
```

[`Py_mod_gil` set to `Py_MOD_GIL_NOT_USED`](https://docs.python.org/3/c-api/module.html#c.Py_mod_gil) is the promise
that keeps the GIL off. The other slot,
[`Py_mod_multiple_interpreters`](https://docs.python.org/3/c-api/module.html#c.Py_mod_multiple_interpreters) set to
`Py_MOD_PER_INTERPRETER_GIL_SUPPORTED`, is the neighbouring promise from [PEP 684](https://peps.python.org/pep-0684/):
the module is happy inside sub-interpreters that each carry their own GIL. Both rest on the same property, and both are
guarded with [`PY_VERSION_HEX`](https://docs.python.org/3/c-api/apiabiversion.html#c.PY_VERSION_HEX) checks so the one
source still builds on CPython 3.10 through 3.15.

That property is the absence of shared mutable state, and it is real rather than a label I stuck on. The state machine
keeps all of its scratch space, the input buffer, the reusable token buffers, the attribute array, inside the
`th_tokenizer` struct it owns; nothing sits in a global. The lookup tables, the 2,231 entities and the nibble tables,
are `const`, written once at compile time and only ever read. `escape` and `unescape` take an immutable `str` and return
a fresh one. Two threads escaping two strings, or tokenizing two documents, never write the same memory, so there is
nothing to lock. The one thing that is not safe, and the docs flag this for any stateful object, is feeding a single
`Tokenizer` from several threads at once: that object has mutable state, so sharing it is your lock to take.

Shipping it is the last piece. A free-threaded interpreter has its own ABI, tagged with a trailing `t` (`cp313t`,
`cp314t`), so it needs
[its own wheels](https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/). turbohtml builds
them with [cibuildwheel](https://cibuildwheel.pypa.io/en/stable/options/#enable), which can add the free-threaded
interpreters to the build matrix, so `pip install turbohtml` lands a ready wheel whether or not your Python has the GIL.

If you maintain a C extension and want to walk this path, the ecosystem has collected the how-to in one place: the
[Python Free-Threading Guide](https://py-free-threading.github.io/) and its
[extension-porting pages](https://py-free-threading.github.io/porting-extensions/), Quansight Labs' write-ups on the
[rollout](https://labs.quansight.org/blog/free-threaded-python-rollout) and
[the first year](https://labs.quansight.org/blog/free-threaded-one-year-recap), and the
[official extension HOWTO](https://docs.python.org/3/howto/free-threading-extensions.html) for the slots above. The same
design that keeps turbohtml fast, no shared scratch space and no hidden globals, is what lets it keep its hands off the
lock.

If you want to read the real thing, it is on [GitHub](https://github.com/tox-dev/turbohtml) and
[PyPI](https://pypi.org/project/turbohtml/) (`pip install turbohtml`), and the C is meant to be read side by side with
the spec. I learned these tricks by reading other people's code, so it seems only fair to make mine easy to read back.

## How this was built

One more thing, since leaving it out would be dishonest. I did not write turbohtml by hand. It came together over about
a month of continuous background work with Anthropic's Opus 4.8, with a little Fable in the mix, across close to 300
pull requests and many more iterations than that. I reviewed most of the code that landed, but I did not type most of
it.

The hours I did put in went to the half that matters more than speed: making sure the answers are correct, because a
fast parser that is subtly wrong is worse than a slow one. Most of that work is harness rather than features. turbohtml
is checked byte for byte against the Python standard library, against the html5lib conformance suite browsers use, and
against the output of the libraries it replaces; the URL, encoding, and Unicode-normalization code is validated against
the standards' own reference test vectors. Where a spec already has a trusted implementation in another language, I ran
differential tests against it, so a result has to satisfy Python, Rust, C, C++, and Go implementations and the specs at
once before I believe it. That cross-checking is why I am comfortable publishing something a model and I wrote together.

None of it would exist on its own. The techniques are borrowed and credited throughout, and the correctness is borrowed
too: every competing library I measured against, across the Python, Rust, C, C++, and Go ecosystems, doubled as an
oracle for the right answer, and the people who wrote the HTML, CSS, URL, and ECMAScript specs and the conformance
suites that go with them are the reason any of it can be checked at all. Standing on the shoulders of giants is just the
accurate description here. My thanks to all of them.

## Further reading

- [Bit Twiddling Hacks](https://graphics.stanford.edu/~seander/bithacks.html) by Sean Anderson, the source of the
  has-zero test and most of the bit math here.
- [Parsing Gigabytes of JSON per Second](https://arxiv.org/abs/1902.08318) and
  [Validating UTF-8 in less than one instruction per byte](https://arxiv.org/abs/2010.03090), the simdjson papers behind
  the nibble-table classification.
- [Porting x86 vector bitmask optimizations to Arm NEON](https://developer.arm.com/community/arm-community-blogs/b/servers-and-cloud-computing-blog/posts/porting-x86-vector-bitmask-optimizations-to-arm-neon)
  by Danila Kutenin, for the missing-movemask workaround.
- [PEP 393](https://peps.python.org/pep-0393/), the flexible string representation, and the CPython
  [stringlib](https://github.com/python/cpython/tree/main/Objects/stringlib) sources it inspired.
- [html5ever](https://github.com/servo/html5ever), the Servo HTML parser whose data-state run scanning I borrowed.
- The [WHATWG tokenization spec](https://html.spec.whatwg.org/multipage/parsing.html#tokenization), the state machine
  itself.
- [PEP 703](https://peps.python.org/pep-0703/), the proposal to make the GIL optional, and the
  [C API free-threading HOWTO](https://docs.python.org/3/howto/free-threading-extensions.html) for porting extensions.
- The [Python Free-Threading Guide](https://py-free-threading.github.io/), a community collection of porting notes and
  an ecosystem compatibility tracker.
- [RFC 3492](https://www.rfc-editor.org/rfc/rfc3492), the Punycode bootstring algorithm, and
  [UTS #46](https://www.unicode.org/reports/tr46/) and [UAX #15](https://www.unicode.org/reports/tr15/), the IDNA
  mapping and Unicode normalization the host encoder implements.
- [Honza Hubička's link-time optimization series](http://hubicka.blogspot.com/2014/04/linktime-optimization-in-gcc-1-brief.html)
  and the GCC [LTO overview](https://gcc.gnu.org/onlinedocs/gccint/LTO-Overview.html), on re-inlining across translation
  units.
- [Go's profile-guided optimization docs](https://go.dev/doc/pgo), the clearest writeup of the
  training-representativeness and profile-flapping pitfalls that bite every PGO build.
- [Cachegrind and Callgrind](https://valgrind.org/docs/manual/cl-manual.html), the instruction-counting profilers behind
  reproducible benchmarks, and
  [Reliable benchmarking in noisy environments](https://pythonspeed.com/articles/consistent-benchmarking-in-ci/) by
  Itamar Turner-Trauring, on why CI benchmarks need them.
