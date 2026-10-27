+++
author = "Bernat Gabor"
date = 2026-10-26T22:00:00Z
description = "PyBeach 2026 notes: free-threading costs, class internals, SPICE in the browser, K–12 CS, supply chains, code review, mountain rescue, and docs for LLMs."
draft = false
image = "pybeach-2026-opening-og.webp"
images = [ "pybeach-2026-opening-og.webp"]
slug = "pybeach-2026-recap"
topics = [ "python", "pybeach", "conference", "los-angeles", "free-threading", "subinterpreters", "descriptors", "metaclasses", "spiceypy", "pyodide", "supply-chain", "security", "code-review", "incident-response", "documentation", "llm", "education"]
title = "PyBeach 2026 Recap"
+++

[PyBeach](https://2026.pybeach.org/) is the Los Angeles area's community Python conference. The 2026 edition was a
single-track, single-day event on Saturday, October 24, at the [Illusion Magic Lounge](https://illusionmagiclounge.com/)
in Santa Monica: eight talks and a block of lightning talks. This post is a synthesis of my notes and the messages I
heard during the conference.

> [!TLDR] **TLDR:**
>
> - **Humans fail in predictable ways, so design for it.** Noah Kantrowitz argued for checklists, objective tooling, and
>   honest limits on what code review can catch. Andrew Godwin brought the same lesson from mountain rescue: practice
>   the response before you need it, keep spare capacity in the schedule, and let anyone call stop.
> - **Removing the GIL has a price.** Christopher Neugebauer benchmarked sub-interpreters and the free-threaded build on
>   ordinary Python code. Free-threading made shared-data workloads slower; isolating data between workers is what made
>   things fast.
> - **Your readers increasingly arrive through an LLM.** Maggie Fero showed how chunking, recency weighting, and
>   reversed negations change what users get from your docs, and what to write differently.
> - **You can use classes without most of their machinery.** Trey Hunner walked through descriptors, metaclasses, and
>   `super()`, starting from the point that you don't need most of it to use classes.
> - **Python keeps reaching new places.** Andrew Annex ran NASA's SPICE toolkit live in the slides through Pyodide.
>   Elizabeth Bacon covered where Python sits in K–12 classrooms under the new CSTA standards.
> - **The supply chain is still the attack surface.** My talk walked through nine findings from virtualenv's own code
>   and release pipeline, against the March 2026 Trivy/LiteLLM and April 2026 Elementary incidents.

## Morning

### Christopher Neugebauer: Adventures in GIL-Free Python (finally!)

{{< figure src="christopher-neugebauer-gil-free-python.webp" width="900" alt="Christopher Neugebauer at the podium with his 'Adventures in GIL-free Python (finally)' title slide" >}}

Christopher kicked off the day. He's a former [PSF](https://www.python.org/psf/board/) director and vice chair,
co-organizes [North Bay Python](https://northbaypython.org/), and he last talked about Python concurrency at
[PyBay](https://pybay.org/) 2023, solving [Wordle](https://www.nytimes.com/games/wordle/index.html) with parallel tools.
This was the update, framed around *why* CPython looks the way it does.

**Why the GIL exists.** One line of Python can do a lot of allocation and reference-count bookkeeping, and CPython
guarantees that each bytecode instruction leaves memory in a coherent state. With operating-system threads, that
guarantee needs locks. CPython can also be embedded in C programs that manage their own threads, so in practice
everything needs locking. One global lock is the cheapest way to get there: a thread holds it while it runs Python and
hands it over at switch points or around blocking I/O, so single-threaded code pays almost nothing for per-object
locking. The cost is that only one thread runs Python at a time.

**Should you care?** Probably not, he said. Python gets faster every release, network-bound code is better served by
[asyncio](https://docs.python.org/3/library/asyncio.html), and compute-heavy workloads often belong in another language.
The cases that do care are existing code that would benefit from parallelism, or extension code that still needs to
touch Python objects. He compared three ways around the GIL:

- **Processes** via [`multiprocessing`](https://docs.python.org/3/library/multiprocessing.html) and
  [`ProcessPoolExecutor`](https://docs.python.org/3/library/concurrent.futures.html#processpoolexecutor). Each process
  has its own GIL. Arguments and results passed through the pool are serialized and copied (unless you reach for
  [`multiprocessing.shared_memory`](https://docs.python.org/3/library/multiprocessing.shared_memory.html)), and process
  start-up is more expensive on Windows.
- **Sub-interpreters.** Long available from the C API for embedders, but all interpreters shared one GIL until Python
  3.12 gave each its own ([PEP 684](https://peps.python.org/pep-0684/)). Python 3.14 exposes them to Python code through
  [`concurrent.interpreters`](https://docs.python.org/3/library/concurrent.interpreters.html) and
  [`InterpreterPoolExecutor`](https://docs.python.org/3/library/concurrent.futures.html#interpreterpoolexecutor)
  ([PEP 734](https://peps.python.org/pep-0734/)). Mutable objects must be copied between interpreters; immutable ones
  (strings, tuples) can be shared. Swapping `ProcessPoolExecutor` for `InterpreterPoolExecutor` sped up both his
  palindrome demo and the old Wordle solver. He noted that `InterpreterPoolExecutor` still serializes what passes
  through its queue, and suspected the gain could be larger without that.
- **Free-threading** ([PEP 703](https://peps.python.org/pep-0703/)), a separate build you have to ask for. It puts locks
  on individual objects, and the [free-threading HOWTO](https://docs.python.org/3/howto/free-threading-python.html) puts
  the average single-threaded overhead on [pyperformance](https://github.com/python/pyperformance) at about 1% on macOS
  aarch64 and 8% on x86-64 Linux. As he put it, that's the worst combination, cheap on your laptop and expensive in
  production.

The benchmarks were the surprise. On an M1 MacBook Air, the Wordle solver on a free-threaded thread pool got *slower* in
wall-clock time, which he attributes to lock contention on data structures shared between threads. Running the same code
with sub-interpreters on the free-threaded build, where each worker gets its own copy, was faster. A pure CPU loop with
nothing shared ran about three times faster with free-threading, short of the roughly eight times he'd expect if it
scaled optimally. Sub-interpreters improved that further, because they also avoid contention on the interpreter's own
internal structures.

He expects the GIL to stay around for a while, and he's fine with that. In a free-threaded build you can't declare that
an object will not be mutated across threads, so every object pays for thread safety. Sub-interpreters give you
parallelism on the standard build if you think about what crosses the boundary between tasks. Free-threading gives you
shared memory at the cost of complexity you cannot opt out of.

### Elizabeth Bacon: Supporting the Next Generation of Pythonistas

{{< figure src="pybeach-photo-bacon.webp" width="900" alt="Elizabeth Bacon on stage with her title slide, 'Supporting the Next Generation of Pythonistas'" caption="Photo: [@pybeach](https://fosstodon.org/@pybeach/117497119822087944)" >}}

Elizabeth was up next. She teaches middle school computer science at [Wildwood School](https://www.wildwood.org/) in Los
Angeles, represents LA County for the [Computer Science Teachers Association](https://csteachers.org/) (CSTA), and sits
on the CSTA conference committee. Her talk was a tour of the K–12 landscape for people who mostly see it from the
outside. She opened by asking the room what CS education is for, then mapped the answers onto a 2019
[CUNY](https://www.cuny.edu/) study of the reasons people give: equity and social justice, competencies and literacies,
citizenship, innovation, workforce development, school improvement, and her favorite, personal agency and joy. Then came
the headlines about the "end of coding", falling CS enrollment, and Microsoft replacing its
[TEALS](https://www.microsoft.com/en-us/teals) volunteer program, which put teachers in an existential crisis. In the
classroom they're still teaching kids to code, and she's had people from Microsoft ask her to keep going.

{{< figure src="elizabeth-bacon-csta-priorities.webp" width="900" alt="Elizabeth Bacon's slide contrasting the CSTA standards' enduring priorities with the new emerging priorities" >}}

**The new CSTA standards.** The
[revised PK–12 standards](https://csteachers.org/2026-csta-pk-12-computer-science-standards/) replace the 2017 version,
which, in her words, took CS101 and stretched it from kindergarten to twelfth grade. The new framework has five concepts
(algorithms and design, programming, data and analysis, systems and security, computing and society) under cross-cutting
practices. The slide above shows the shift: algorithms, programming, data, and computing systems remain as enduring
priorities, while ethics and impacts, AI, human-centered design, inclusive collaboration, history of computing, and
career exploration are what CSTA calls "new or expanded priorities". High schools can also offer specialty courses in
areas like AI, cybersecurity, game design, data science, or physical computing.

**Who actually decides.** CSTA publishes standards; state legislatures decide what is taught. In California a course
needs [A–G](https://hs-articulation.ucop.edu/guide/) approval to count toward University of California admission, career
and technical education courses follow their own state standards to get federal
[Perkins](https://cte.ed.gov/legislation/perkins-v) funding, and AP courses follow
[College Board](https://www.collegeboard.org/)'s own course frameworks, so teachers end up reconciling several sets of
requirements at once. Of the AP CS courses, only
[AP CS Principles](https://apcentral.collegeboard.org/courses/ap-computer-science-principles) can be taught in Python;
[AP CS A](https://apcentral.collegeboard.org/courses/ap-computer-science-a) is still Java. She thinks AP CS A won't
switch because Python is too easy. For younger students, schools treat it as *too hard*, yet when JavaScript lets a
12-year-old add a number to a string, the student learns nothing about data types.

Python shows up in classrooms through blocks-to-text environments like [MakeCode Arcade](https://arcade.makecode.com/),
turnkey curricula, after-school clubs, and open courses like [CS50](https://cs50.harvard.edu/). She showed student work:
a transposition ([scytale](https://en.wikipedia.org/wiki/Scytale)) cipher, image
[steganography](https://en.wikipedia.org/wiki/Steganography) in the least significant bits of each pixel, LLM
benchmarking scripts, a Python-controlled robotic hand, and a soft-robotics project whose student planned to add Python
control, then moved on to other things.

**How industry people can help:** visit classrooms, join a district's career and technical education advisory committee
(required by law, and constantly looking for volunteers; show up to every meeting and you'll be the chair next year),
comment on California's upcoming standards revision, and push back on AI-literacy curricula that amount to vendor
product training. Sheena O'Connell's [Guild of Educators](https://guildofeducators.org/) runs a Discord and discussion
groups on teaching practice, and the [Greater LA CSTA chapter](https://greaterlosangeles.csteachers.org/home) holds
local meetups.

### Trey Hunner: Everything You Don't Need to Know About Classes in Python

{{< figure src="pybeach-photo-hunner.webp" width="900" alt="Trey Hunner on stage in front of a slide listing the class topics he would and would not cover" caption="Photo: [@pybeach](https://fosstodon.org/@pybeach/117497297789662875)" >}}

After the morning break, Trey (PSF fellow, runs [Python Morsels](https://www.pythonmorsels.com/)) opened with a game:
function or class? [`print`](https://docs.python.org/3/library/functions.html#print) and
[`sorted`](https://docs.python.org/3/library/functions.html#sorted) are functions;
[`str`](https://docs.python.org/3/library/functions.html#func-str),
[`reversed`](https://docs.python.org/3/library/functions.html#reversed),
[`type`](https://docs.python.org/3/library/functions.html#type),
[`enumerate`](https://docs.python.org/3/library/functions.html#enumerate), and
[`list`](https://docs.python.org/3/library/functions.html#func-list) are classes. In Python, "function" usually means
"callable". He then put 25 topics on screen and promised to cover about a dozen in 25 minutes, telling the room from the
start that you don't need to know most of this to use classes.

**Methods are functions attached to classes.** `numbers.append(7)` is
[`list.append(numbers, 7)`](https://docs.python.org/3/library/stdtypes.html#mutable-sequence-types), which is why
[`sorted(words, key=str.lower)`](https://docs.python.org/3/library/stdtypes.html#str.lower) works. You can define a
function outside a class, assign it as a class attribute, and every instance gains a method.
[`self`](https://docs.python.org/3/tutorial/classes.html#random-remarks) is a convention; Python passes the instance
positionally whether you accept it or not.

**Attribute lookup checks the class first.** Instances store attributes in
[`__dict__`](https://docs.python.org/3/reference/datamodel.html#object.__dict__) (unless the class uses
[`__slots__`](https://docs.python.org/3/reference/datamodel.html#slots)). A
[`property`](https://docs.python.org/3/library/functions.html#property) lives on the class, and it is a
[*data descriptor*](https://docs.python.org/3/howto/descriptor.html#descriptor-protocol): its class defines both
[`__get__`](https://docs.python.org/3/reference/datamodel.html#object.__get__) and
[`__set__`](https://docs.python.org/3/reference/datamodel.html#object.__set__), so it wins over a same-named key in the
instance's `__dict__`. Trey proved the order by writing to `__dict__` directly and watching the property still answer.
[`functools.cached_property`](https://docs.python.org/3/library/functools.html#functools.cached_property) is a non-data
descriptor: it stores its result on the instance, so the next lookup finds it there first. Functions defined in Python
are also descriptors, and [`function.__get__`](https://docs.python.org/3/howto/descriptor.html#functions-and-methods) is
what turns a looked-up function into a
[bound method](https://docs.python.org/3/reference/datamodel.html#instance-methods).

**[Metaclasses](https://docs.python.org/3/reference/datamodel.html#metaclasses) and
[`super()`](https://docs.python.org/3/library/functions.html#super).**
[`__mro__`](https://docs.python.org/3/reference/datamodel.html#type.__mro__) lives on the metaclass, which is why
instances don't have it. Calling a class calls
[`type.__call__`](https://docs.python.org/3/reference/datamodel.html#object.__call__), which runs
[`__new__`](https://docs.python.org/3/reference/datamodel.html#object.__new__) and then
[`__init__`](https://docs.python.org/3/reference/datamodel.html#object.__init__). Before writing a metaclass, reach for
`__new__`, [`__init_subclass__`](https://docs.python.org/3/reference/datamodel.html#object.__init_subclass__), or a
[class decorator](https://docs.python.org/3/reference/compound_stmts.html#class-definitions). Zero-argument `super()`
works because methods that reference it get a hidden
[`__class__` closure cell](https://docs.python.org/3/reference/datamodel.html#creating-the-class-object) from the
compiler; a function attached to a class after the fact doesn't, so its `super()` breaks. And in the reverse direction,
[`typing.NamedTuple`](https://docs.python.org/3/library/typing.html#typing.NamedTuple) is a function you can inherit
from, thanks to [`__mro_entries__`](https://docs.python.org/3/reference/datamodel.html#object.__mro_entries__).

The [talk page](https://treyhunner.com/classes-talk/) has the [slides](https://treyhunner.com/classes-talk/slides/) and
a reading list for each section, including his [descriptors article](https://www.pythonmorsels.com/descriptors/), Brett
Cannon's [Unravelling attribute access](https://snarky.ca/unravelling-attribute-access-in-python/), and the official
[Descriptor Guide](https://docs.python.org/3/howto/descriptor.html).

### Andrew Annex: Accessing NASA Planetary Ephemeris with SpiceyPy

{{< figure src="pybeach-photo-annex.webp" width="900" alt="Andrew Annex on stage with the slide 'When is the next partial solar eclipse visible from Santa Monica?'" caption="Photo: [@pybeach](https://fosstodon.org/@pybeach/117497406378526385)" >}}

The last talk before lunch came from Andrew, a planetary scientist at the [SETI Institute](https://www.seti.org/), a
member of the [Mars 2020](https://science.nasa.gov/mission/mars-2020-perseverance/) and
[VIPER](https://science.nasa.gov/mission/viper/) rover science operations teams, and a senior software engineer at
[Planet](https://www.planet.com/). Andrew started [SpiceyPy](https://github.com/AndrewAnnex/SpiceyPy) in 2014. It wraps
[NASA JPL](https://www.jpl.nasa.gov/)'s [SPICE toolkit](https://naif.jpl.nasa.gov/naif/toolkit.html): positions and
orientations of planets and spacecraft over time, instrument mounting and fields of view, and the geometry to ask
questions like "when will this asteroid pass in front of this star from this surface point?". SPICE dates back to
[Voyager](https://science.nasa.gov/mission/voyager/) and stores its data in binary and text "kernels".

{{< figure src="andrew-annex-fortran-to-pip-install.webp" width="900" alt="Andrew Annex's 'From Fortran to pip install' slide: Fortran 77 to f2c to CSPICE to a CMake shared library to SpiceyPy, with a wheel matrix including wasm32" >}}

**From Fortran to `pip install`.** [NAIF](https://naif.jpl.nasa.gov/naif/)'s Fortran 77 is machine-translated to C by
[`f2c`](https://www.netlib.org/f2c/), giving CSPICE (about 2,200 C files). SpiceyPy builds it as a shared library with
[CMake](https://cmake.org/) through [scikit-build-core](https://scikit-build-core.readthedocs.io/), wraps 600+ functions
with [ctypes](https://docs.python.org/3/library/ctypes.html) (plus a [Cython](https://cython.org/) submodule since
2025), and uses [cibuildwheel](https://cibuildwheel.pypa.io/) to produce 31 wheels per release, including a WebAssembly
wheel for the browser via [PEP 783](https://peps.python.org/pep-0783/). The slides recommend at least one pytest per
wrapped function for any C wrapper, run against every wheel, including inside Pyodide.

The demos ran live in the slides with [Pyodide](https://pyodide.org/) and [PyScript](https://pyscript.net/):

- Mars 2020 *Perseverance*'s traverse to the Three Forks sample depot, plotted from 21,600 positions returned by one
  vectorized [`spkpos`](https://spiceypy.readthedocs.io/en/main/documentation.html#spiceypy.spiceypy.spkpos) call, then
  overlaid on the [HiRISE](https://www.uahirise.org/) mosaic with
  [folium](https://python-visualization.github.io/folium/).
- [Cassini](https://science.nasa.gov/mission/cassini/)'s 2009 E8 flyby of
  [Enceladus](https://science.nasa.gov/saturn/moons/enceladus/), computed in Python and replayed in 3D with
  [three.js](https://threejs.org/).
- The next solar eclipse visible from the venue. The demo pinned a new SPICE body to the building's coordinates on
  Earth's surface, with zero velocity, a choice
  [Maggie Fero quoted](https://hachyderm.io/@MaggieFero/117497446107689150) from the talk: "Since I don't know the
  velocity of Santa Monica with respect to the center of the Earth". It then searched through 2033 with SPICE's geometry
  finder. The slide's comparison table lists January 14, 2029 first, with 51.6% of the Sun covered in LA according to
  [time.now](https://time.now/los-angeles/eclipses/2029-01-14/).

Slides: [andrewannex.com/pybeach_2026_spiceypy_talk](https://andrewannex.com/pybeach_2026_spiceypy_talk/)
([source](https://github.com/AndrewAnnex/pybeach_2026_spiceypy_talk/)). Docs, including the browser build:
[spiceypy.readthedocs.io](https://spiceypy.readthedocs.io/).

## Afternoon

### Bernát Gábor: Securing Your Python Supply Chain, From Dependencies to Deployment

{{< figure src="pybeach-photo-gabor.webp" width="900" alt="Bernát Gábor on stage with his intro slide listing virtualenv, tox, pipx, platformdirs and filelock" caption="Photo: [@pybeach](https://fosstodon.org/@pybeach/117497969949478275)" >}}

After lunch it was my turn. My talk followed a package through source, dependencies, build, publish, install, and
respond, using nine problems I found in [virtualenv](https://virtualenv.pypa.io/)'s own code and release pipeline. Two
2026 incidents framed it:

- **LiteLLM (March).** [LiteLLM](https://github.com/BerriAI/litellm)'s [CircleCI](https://circleci.com/) release
  environment ran an unpinned [Trivy](https://trivy.dev/) scanner that could read static release secrets, including the
  PyPI credential. The maintainers linked that access to the malicious releases, which received over 119,000 downloads
  in the two and a half hours before PyPI quarantined them.
- **[Elementary](https://github.com/elementary-data/elementary) (April).** A PR comment was substituted into a
  workflow's shell script, and the attacker used the workflow token to dispatch the release. The malicious CLI stayed on
  [PyPI](https://pypi.org/) and in its Docker image registry for eleven and a half hours.

The nine findings landed on four of those stops:

- **Source (findings two to seven):** activation-script quoting bugs across [bash](https://www.gnu.org/software/bash/),
  [fish](https://fishshell.com/), [zsh](https://www.zsh.org/), and
  [`cmd.exe`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd), where a path or
  prompt became a command. virtualenv published 21 advisories in five weeks. Our [CodeQL](https://codeql.github.com/)
  queries treated the quoting call as a barrier, so they could not see wrong quoting rules or a later replacement that
  edited the quoted value. Keep regression examples both ways, and fuzz for the property "no extra command runs".
- **Dependencies (finding eight):** virtualenv downloaded pip and setuptools updates without checking their hashes. Hash
  pinning in [`requirements.txt`](https://pip.pypa.io/en/stable/reference/requirements-file-format/) or
  [`pylock.toml`](https://packaging.python.org/en/latest/specifications/pylock-toml/) rejects a wheel whose only change
  is a one-character ZIP comment. Lock the release tools too.
- **Build (finding one):** the job that generated the changelog also held the release credential. We split it so the
  unprivileged job produces text and the privileged one validates and commits it. [zizmor](https://docs.zizmor.sh/)
  lints for the Elementary-style template injection. Start every [GitHub Actions](https://docs.github.com/en/actions)
  workflow from
  [`permissions: {}`](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#permissions),
  pin Actions, turn off checkout's persisted credentials, don't restore shared caches in the release job, and restrict
  the hosts the build can reach.
- **Respond (finding nine):** our rebuilds didn't match because the SBOM embedded in the wheel recorded build-machine
  details; we removed them. The SBOM ([PEP 770](https://peps.python.org/pep-0770/)) is what answers "are we affected?"
  when an advisory lands, because it lists what ships *inside* the wheel: virtualenv bundles pip (which vendors requests
  and urllib3) and setuptools (which vendors its own dependencies), and
  [`pip list`](https://pip.pypa.io/en/stable/cli/pip_list/) shows none of them.

The other two stops got advice rather than findings:

- **Publish:** [Trusted Publishing](https://docs.pypi.org/trusted-publishers/) replaces the long-lived token with one
  that expires within 15 minutes. Attestations tie a file to the workflow that built it. In the
  [Ultralytics](https://blog.pypi.org/posts/2024-12-11-ultralytics-attack-analysis/) incident, the later malicious
  uploads had no attestation, which told investigators they came through an old API token.
- **Install:** a dependency cooldown, with
  [`exclude-newer`](https://docs.astral.sh/uv/concepts/resolution/#dependency-cooldowns) in
  [uv](https://docs.astral.sh/uv/) or [`--uploaded-prior-to`](https://pip.pypa.io/en/stable/cli/pip_lock/) in pip. uv
  can exempt a single package for an urgent fix with
  [`exclude-newer-package`](https://docs.astral.sh/uv/reference/settings/#exclude-newer-package); pip has no per-package
  exception. Run [pip-audit](https://github.com/pypa/pip-audit) on the lock file.

Slides: [gaborbernat.github.io/pybeach-2026](https://gaborbernat.github.io/pybeach-2026/). For a longer treatment, see
my earlier post on [Python supply chain security](/posts/securing-python-supply-chain/).

### Noah Kantrowitz: I am bad at things – And that's okay

{{< figure src="pybeach-photo-kantrowitz.webp" width="900" alt="Noah Kantrowitz on stage with his 'What Is Code Review For?' slide: reducing defects, team training, architecture consensus, specialist consultation" caption="Photo: [@pybeach](https://fosstodon.org/@pybeach/117498184396117900)" >}}

Noah followed me. He runs infrastructure at [Geomagical Labs](https://www.geomagical.com/), part of
[IKEA](https://www.ikea.com/), and opened with a simple observation. Every team he has been on was staffed by humans,
and humans make mistakes in predictable ways. The talk isn't about AI, he said, though in large part it is "a scream
into the void" about the stress AI tools add.

**How we fail.** Confirmation bias (seven powerful words: *you are already doing the right thing*), inattentional
blindness, recency bias, repetition blindness (which code, being more repetitive than prose, amplifies), and
overconfidence bias, which "pervades our industry like almost nowhere else". In passing he asked people to stop citing
[Dunning–Kruger](https://en.wikipedia.org/wiki/Dunning%E2%80%93Kruger_effect).

**Checklists.** He learned *plan your dive and dive your plan* as a scuba diver. The tasks that need a checklist happen
often, are repetitive, are done under stress, and carry a high cost of error. He writes them for code review, for
deployments, and for the first response to an outage. A checklist must be followable as written (few or no steps people
are expected to skip, and no "don't write bugs"), practiced before it matters, and blameless: a bad outcome after
following it is a process failure.

**Objective tools.** `assert True` passes and tells you nothing, and in his experience 100% coverage mandates turn into
a number-chasing mini-game. He prefers *patch* coverage on each merge request (he recommended
[Codecov](https://about.codecov.io/)), phrased as "have you considered how to test this line?". Static types shrink the
input space, and linters and formatters end style arguments. Turn cultural rules into plugins wherever you can.

**Code review.** It serves four purposes: catching defects, teaching, architecture consensus, and subject-matter
consultation. It is bad at the first. He splits it into *micro* review (single lines, names, conventions; often
automatable into lint rules) and *macro* review (the whole diff). In macro review, overloaded engineers instinctively
review the author's mental state: check the first of three similar endpoints carefully, skim the others. That heuristic
fails on generated code, because a stochastic generator can be wrong anywhere and the first endpoint being right tells
you nothing about the third.

**The human cost.** "We'll just notice and fix it" asks for hypervigilance, which leads to anxiety, exhaustion, and
burnout. Treat cognitive load like RAM: move background loops (like "did I forget that review?") into a
[Slack](https://slack.com/) bot, and shift load between teammates. The talk ended on kindness, toward yourself and
toward your team.

He gave the same talk at [PyCon AU 2026](https://2026.pycon.org.au/):
[slides](https://speakerdeck.com/coderanger/i-am-bad-at-things),
[slides with speaker notes](https://speakerdeck.com/coderanger/i-am-bad-at-things-with-notes), and the
[recording](https://www.youtube.com/watch?v=iwuUqhBWncA).

### Andrew Godwin: Working With Risk, Lessons From Mountain Rescue

{{< figure src="andrew-godwin-mountain-rescue.webp" width="900" alt="Andrew Godwin's intro slide: mountain rescue since 2023, Python things since 2005, lives in Denver, Colorado" >}}

Andrew (technical lead for [Lambda](https://lambda.ai/)'s cloud platform, author of
[Django](https://www.djangoproject.com/)'s [South](https://south.readthedocs.io/) and migrations,
[Channels](https://github.com/django/channels), and [Takahē](https://jointakahe.org/), doing "Python things since 2005")
came next, with what he does away from the keyboard: he volunteers with
[Alpine Rescue Team](https://alpinerescueteam.org/), one of the older mountain rescue teams in the US, founded in 1959
and covering the I-70 corridor west of Denver. Rescues are mostly ground teams and litters, not helicopters, and the
work splits into search, rescue, and recovery. Terrain adds a dimension: flat ground, low angle (a rope is part of the
safety system), and high angle (the rope holds your full weight).

**The risk matrix.** Risk has two axes: likelihood and consequence. Mountain rescue is high consequence by selection,
since "at least one person is already having a bad day", so the team works on likelihood. (The most dangerous part is
driving to the rescue.) Their tools: a safety culture (*slow is smooth, smooth is fast*), more hours of training than
missions in some years, and a clear command structure, studied from FEMA's
[incident command guidance](https://training.fema.gov/emiweb/is/icsresource/). Software can move both axes:

- **Consequence:** contain the blast radius, don't keep data you don't need, and isolate what you must keep from the
  main system ("you can't leak what you don't have"), and measure your rollback time, not your deploy time.
- **Likelihood:** test the disaster-recovery plan (one of his past teams failed over to the other data center every
  month), practice what happens most plus what costs most, stop scheduling people at 100%, and ship small changes.

**Safety culture has two halves.** Blamelessness is the half software adopted. The other is that anyone can say stop and
actually get an evaluation. Ask whether a junior engineer flagging a security issue would halt your deploy. That goes
together with clear leadership, because *rescue is not a democracy*. Advice is heard, then one accountable person makes
the call. And watch for heroics, because the people who always save the day are hiding a map of process failures that
surfaces the day they leave.

He closed by noting that Alpine Rescue Team never charges for a rescue, and that teams would rather you call as soon as
you think you have a problem than later. Slides:
[speakerdeck.com/andrewgodwin](https://speakerdeck.com/andrewgodwin/working-with-risk-lessons-from-mountain-rescue). His
related [EMF 2026](https://www.emfcamp.org/) talk,
[Mountains, Rescues, and Risks](https://media.ccc.de/v/emf2026-211-1-mountains-rescues-and-risks), has a recording.

### Margaret Fero: Technical Documentation in the Age of LLMs

{{< figure src="pybeach-photo-fero.webp" width="900" alt="Maggie Fero on stage with their agenda slide" caption="Photo: [@pybeach](https://fosstodon.org/@pybeach/117498980233331195)" >}}

After the snack break, Maggie ([margaretfero.com](https://margaretfero.com/), a former technical writer who now teaches
cybersecurity and AI) gave the last full talk of the day. Their core point was that many of your users are LLM users,
whether or not you are, and you no longer own the front door to your docs. Less has changed than people assume, but
several "nice to haves" are now critical.

**Unchanged: docs affect security.** Your docs include marketing pages, commit messages, and anything an LLM can pull
in. Default credentials, anti-recommended settings, and limitations that hint at backend weaknesses all leak. They cited
California's [SB-327](https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=201720180SB327): since 2020,
a connected device that can be logged into from outside the local network must ship with a unique password per device or
make the user set new credentials before first use. Obscurity was never security, and search makes that worse: in
[Irregular](https://www.irregular.com/)'s
[tests](https://www.scworld.com/perspective/gemini-hacked-three-companies-the-ai-isnt-the-part-that-should-scare-you)
[Gemini](https://gemini.google.com/) got into three companies' systems, two of them with credentials committed to public
repositories. [GitGuardian's 2026 report](https://gitguardian.com/state-of-secrets-sprawl-report-2026) found 64% of
secrets confirmed valid in 2022 still working in January 2026, and the 2026
[Verizon DBIR](https://www.verizon.com/business/resources/reports/dbir/) attributes 13% of initial access to credential
abuse.

{{< figure src="margaret-fero-match-queries.webp" width="900" alt="Maggie Fero's 'Match Queries Well' slide introducing generative engine optimization (GEO) and answer engine optimization (AEO)" >}}

**Unchanged: one document, one use case.** Overviews, tasks, references, troubleshooting, and news each have their job.
Mixing them (troubleshooting inside a procedure) reads as hedging and matches queries worse.
[Generative engine optimization](https://en.wikipedia.org/wiki/Generative_engine_optimization) (GEO, also called answer
engine optimization) is the name for writing so AI search finds the right part. They cited
[TechCrunch's report](https://techcrunch.com/2026/07/27/googles-ai-search-is-rapidly-becoming-the-default-new-data-shows/)
of Similarweb data: AI Overviews went from 15% to 43% of Google searches in a year, so assume your reader's first
contact is a summary.

**Different: length, links, freshness, and wording.**

- Answer engines split pages into chunks and match chunks, not pages. Maggie cited a
  [MaxAEO study](https://maxaeo.ai/blog/page-length-ai-citations/) where the same claim survived into AI answers 72% of
  the time in a page's introduction and 24% in the middle. Put what matters early. The study suggests splitting a long
  page only when it covers genuinely distinct subtopics; otherwise keep it whole and move the key evidence up.
- Context windows look large until you subtract the user's conversation and the tool's own system context. Their
  spreadsheet demo showed Gemini processing only the top and bottom rows of a sheet with tens of thousands of rows,
  giving an answer that read as if it covered everything, and disclosing the gap only inside the collapsed thinking
  section.
- Links to other pages build authority and make citation more likely. In the talk, Maggie said links within a page help
  less, though they can tie related chunks together;
  [afterwards they clarified](https://hachyderm.io/@MaggieFero/117498521528406142) that internal linking carries no big
  penalty but "typically just doesn't help".
- Freshness matters more than it used to. Maggie cited an
  [Ahrefs study](https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content/) finding that pages AI
  assistants cite are on average about 25.7% newer than pages in Google's organic results. Maggie recommended updating
  existing pages over writing new ones.
- Use the same words as your users, since semantic similarity drives the match.
- "Don't do this unless…" is risky: the warning can land in a different chunk, and LLMs often reverse the negation. The
  next day they shared [an example](https://hachyderm.io/@MaggieFero/117502942039772933) of exactly that.

**Spotting LLM-mediated support requests.** Signs include formality that doesn't fit the venue, unusual punctuation
habits, instructions that slide into a competitor's procedure, and exotic troubleshooting with the basics skipped (a
registry edit before clearing the browser cache). AI-writing detectors are bogus and penalize people who write
professionally, especially in open source. Check your traffic for LLM user agents, and use
[`robots.txt`](https://www.rfc-editor.org/rfc/rfc9309) to allow the retrieval crawlers while blocking the training ones,
which most vendors now run separately. The homework Maggie left the room with: find one long document and split it in
two.

### Lightning talks

The day closed with a block of five-minute lightning talks.

- **Philip James** ([@phildini](https://wandering.shop/@phildini)): *Three (or whatever) ways to put something on the
  internet*, about reverse proxies, which he admitted he only recently understood are proxies that work in reverse.
  [Caddy](https://caddyserver.com/) as a single ingress that routes to services anywhere it can reach,
  [ngrok](https://ngrok.com/) (including [OpenID Connect](https://openid.net/developers/how-connect-works/) in front of
  apps that have no auth), and [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). Combine them to serve a
  [Raspberry Pi](https://www.raspberrypi.com/) in your garage without exposing your house. Philip also runs
  [Civic Band](https://civic.band/).
  [Slides](https://speakerdeck.com/phildini/3-or-whatever-ways-to-put-something-on-the-internet).
- **Bernát Gábor** (me): *One smiley, a lot of RAM*. A million `"a"` characters take about 1 MB in CPython; add one 🙂
  and [`sys.getsizeof`](https://docs.python.org/3/library/sys.html#sys.getsizeof) reports about 4 MB. Under
  [PEP 393](https://peps.python.org/pep-0393/), CPython stores each string with one, two, or four bytes per code point,
  picked by the widest character, so one emoji widens every `"a"`. Encoding to UTF-8 gives a 1,000,004-byte payload, and
  decoding brings back the four-byte layout. Slicing the emoji off creates a second, one-byte string while the original
  stays alive, so the peak goes up to 5 MB before it comes down. The same width split drives the tokenizer in
  [turbohtml](https://turbohtml.readthedocs.io/), described in
  [my article on it](/posts/blazing-fast-html-parser/#one-machine-becomes-three).
  [Slides](https://gaborbernat.github.io/pybeach-2026-lightning/).
- **Kattni** ([@kattni](https://kattstodon.com/@kattni)): PyScribBLE, a Bluetooth Low Energy package built on
  [BeeWare](https://beeware.org/)'s [`toga-code-editor`](https://github.com/beeware/toga-code-editor) and
  [`toga-console`](https://github.com/beeware/toga-console), for editing and running
  [CircuitPython](https://circuitpython.org/) code on a small device from a phone.

## Wrapping Up

Thanks to the organizers (Sarah Kuchinsky, Stephen Kiazyk, and Mario Munoz), PyBeach founder
[Nik Kantar](https://nkantar.social/@nik), the program committee, the volunteers, and the sponsors
([Pallets](https://palletsprojects.com/), [CesiumAstro](https://www.cesiumastro.com/), and individual sponsors Carol
Willing and Amethyst Reese) for putting the day together, to every speaker for sharing their work, and to Maggie Fero
and everyone else who posted notes under #pybeach. The recordings aren't up yet; PyBeach publishes them on its
[YouTube channel](https://www.youtube.com/@pybeach).
