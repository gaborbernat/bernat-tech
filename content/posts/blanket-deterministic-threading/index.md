+++
author = "Bernat Gabor"
date = 2026-05-28T17:57:48Z
description = "How blanket gives Python tests deterministic control over thread scheduling, and why that matters now that free-threaded Python is shipping."
draft = false
image = "splash.webp"
images = [ "splash.webp"]
slug = "blanket-deterministic-threading"
tags = [ "python", "testing", "concurrency", "threading", "free-threading", "blanket", "pycon", "race-condition", "gil"]
title = "Deterministic Multithreaded Testing in Python with blanket"
+++

> [!TLDR] **TLDR:**
>
> - [**The problem**](#why-multithreaded-python-tests-are-flaky): testing multithreaded code is hard because the OS
>   scheduler decides which thread runs when, making race conditions nearly impossible to reproduce in a test suite.
> - [**The solution**](#enter-blanket-deterministic-threading-control): [blanket](https://pypi.org/project/blanket/)
>   wraps real `threading` primitives (Lock, Condition, Event, Barrier, Semaphore) and lets your test act as the
>   scheduler, controlling which thread proceeds at each step.
> - [**Why now**](#why-now): free-threaded Python (no [GIL](https://docs.python.org/3/glossary.html#term-GIL)) shipped
>   experimentally in 3.13, is [officially supported in 3.14](https://docs.python.org/3.14/whatsnew/3.14.html), and
>   keeps maturing in [3.15](https://docs.python.org/3.15/whatsnew/3.15.html). The GIL was hiding thread-safety bugs you
>   didn't know you had; without it, they surface.
> - [**How it works**](#how-it-works-under-the-hood): every method call on a blanket primitive becomes a _transaction_
>   that parks at a _scheduler block_. Your test unblocks transactions in whatever order you want, making execution 100%
>   deterministic.
> - [**What makes it different**](#concurrency-testing-tools-compared): unlike stateless model checkers
>   ([Loom](https://github.com/tokio-rs/loom), [Shuttle](https://github.com/awslabs/shuttle),
>   [CHESS](https://www.microsoft.com/en-us/research/project/chess-find-and-reproduce-heisenbugs-in-concurrent-programs/))
>   that _discover_ bugs by exploring interleavings automatically, blanket lets you _declare_ specific scenarios by
>   hand, useful for regression tests of known bugs and for full coverage of rare code paths.

Most multithreaded Python codebases keep at least one test marked `@pytest.mark.flaky(reruns=5)`: the one that fails
once in a thousand because of a race condition you can't reproduce on demand. The bug is a specific sequence of thread
interactions. You don't get to pick the sequence; the OS scheduler does. You ship the retry and hope.

[blanket](https://github.com/larryhastings/blanket) takes the scheduler's job. Your test decides which thread acquires
the lock next, which order barriers release, which waiter `notify()` wakes. The regression test that used to fail one
run in a thousand now fails (or passes) the same way each run. [Larry Hastings](https://github.com/larryhastings)
presented it at [PyCon US 2026](https://us.pycon.org/2026/schedule/presentation/51). He is a CPython core developer,
author of [Argument Clinic](https://peps.python.org/pep-0436/), release manager for Python 3.4 and 3.5, and the engineer
behind the original [Gilectomy](https://github.com/larryhastings/gilectomy) experiment to remove the GIL.

{{< callout kind="tip" title="When to use blanket:" >}}

- You have a flaky concurrency test you can't reproduce on demand.
- You want a regression test that pins one specific thread interleaving.
- You're porting a library to free-threaded Python and need confidence the locks behave under both schedulers.
- You want test coverage on an `except` branch that fires under one specific ordering.
- You want a concurrency test that reads as a specification of what should happen.

{{< /callout >}}

## Quick start

Install with [uv](https://docs.astral.sh/uv/) (or `pip` if you prefer):

```bash
uv pip install blanket
```

```python
import blanket

scenario = blanket.Scenario()
lock = scenario.Lock()
result: list[str] = []


def worker(name: str) -> None:
    with lock:
        result.append(name)


thread_a = scenario.thread(worker, "A")
thread_b = scenario.thread(worker, "B")
lock_api = scenario.api(lock)

with scenario:
    list(lock_api.relay(thread_b, thread_a))  # force B to take the lock before A
    lock_api.unblock(lock.release, thread_a)

assert result == ["B", "A"]  # the same order on every run
```

Without blanket, `result` lands as `["A", "B"]` or `["B", "A"]` depending on which thread the OS scheduler picks. With
blanket, you pick.

## Why now

[PEP 703](https://peps.python.org/pep-0703/) -- _Making the Global Interpreter Lock Optional in CPython_ -- removes the
[GIL](https://docs.python.org/3/glossary.html#term-GIL), the lock that has historically forced Python to run only one
thread at a time. Without it, threads can execute in parallel on multiple cores -- this mode is called **free-threaded
Python**. The change is not just about speed: it rewires CPython's internals -- biased reference counting, per-object
locking, [mimalloc](https://github.com/microsoft/mimalloc) replacing
[pymalloc](https://docs.python.org/3/c-api/memory.html#the-pymalloc-allocator), stop-the-world GC pauses.

Code the GIL has been serializing, one bytecode at a time, will start showing real data races:

```python
import threading


def increment() -> None:
    global counter
    for _ in range(1_000):
        counter += 1  # read-modify-write: not atomic without the GIL


counter: int = 0
threads = [threading.Thread(target=increment) for _ in range(2)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
```

Run this with the GIL and `counter` ends at 2,000 every time. The program is too short to expose the race, but the GIL
doesn't make `+=` atomic. `counter += 1` compiles to multiple bytecodes (load, add, store), and the GIL releases between
bytecodes (default switch interval 5 ms, set in
[`Python/ceval_gil.c`](https://github.com/python/cpython/blob/main/Python/ceval_gil.c) and adjustable via
[`sys.setswitchinterval`](https://docs.python.org/3/library/sys.html#sys.setswitchinterval)). Two threads doing a
thousand iterations finish in roughly 100 µs, far below one switch interval, so they run serially in practice. Crank the
loop to ten million iterations or sprinkle in any call that releases the GIL, and the race shows up even under the GIL.
Free-threading removes the buffer entirely: two threads run in parallel on separate cores, both read the same value,
both increment it, and one write clobbers the other, leaving `counter` at some unpredictable number below 2,000.

The toy counter understates the case. The Quansight team's free-threading work has turned up concrete receipts: a
[24-year-old data race in `scipy.signal`](https://labs.quansight.org/blog/free-threaded-one-year-recap) the GIL had
masked since the function was written, a numpy crash on parallel `.sum()` calls reporting
`"Identity cache already includes the item"`, a Pillow segfault from C API patterns the GIL had been serializing into
safety. The test suites that passed under the GIL passed because the GIL was doing the locking for them.

Performance is the other concern. [PEP 779](https://peps.python.org/pep-0779/), the criteria document for
free-threading's supported status, pegs the budget at 10% CPU and 15% memory overhead versus the GIL build, with a hard
ceiling of 20%. Python 3.13 shipped at roughly 40% overhead. Python 3.14 lands near 5 to 10% depending on platform. The
"free-threading hurts performance" critique held in 2024; the CPython team's work since has closed most of the gap for
CPU-bound code, though reference-counting-heavy workloads still pay a bigger tax.

Three objections recur. _"Most Python code doesn't use threads. asyncio and multiprocessing cover it."_ asyncio and
multiprocessing do cover I/O-bound application code. Libraries are a different story: numpy, PyTorch, scientific stacks,
and anything wrapping native code with callbacks all run on threads, whether the application above them knows it or not.
_"Subinterpreters would have been the right answer."_ Subinterpreters share less state and are easier to reason about,
but they require copying data across the boundary. Workloads that need shared-memory parallelism need free-threading.
_"The GIL is good."_ For library authors who don't want to think about thread safety, yes. That same comfort is why
Python's concurrency-testing tooling has lagged behind other ecosystems.

As the GIL fades, Python developers face the same concurrency challenges Rust, Go, Java, and C++ have dealt with for
decades. Those ecosystems built tooling: [Loom](https://github.com/tokio-rs/loom) and
[Shuttle](https://github.com/awslabs/shuttle) in Rust, the [race detector](https://go.dev/blog/race-detector) in Go,
[Lincheck](https://github.com/JetBrains/lincheck) and [Thread Weaver](https://github.com/google/thread-weaver) in
JVM-land, [Coyote](https://microsoft.github.io/coyote/) in .NET, [Jepsen](https://jepsen.io/) for distributed systems.
Python's concurrency testing story has been thin because the GIL made it less urgent.
[blanket](https://github.com/larryhastings/blanket) is the first serious entry in what will need to become a richer
ecosystem.

## Synchronization primitives

blanket wraps the seven synchronization primitives Python's
[`threading`](https://docs.python.org/3/library/threading.html) module ships. Each one solves a specific coordination
problem, and each creates a specific class of testing nightmare.

### Lock

A [`Lock`](https://docs.python.org/3/library/threading.html#threading.Lock) is single-occupancy: at any moment one
thread holds it. Any other thread calling `acquire()` blocks until the holder calls `release()`. Reach for it when "two
threads doing this at once" is the bug.

A web server tracking active requests needs a lock to safely update the counter from multiple threads:

```python
import threading

active_requests: int = 0
request_lock = threading.Lock()


def handle_request() -> None:
    global active_requests
    with request_lock:  # acquire() on entry, release() on exit
        active_requests += 1
    # ... process request ...
    with request_lock:
        active_requests -= 1
```

Without the lock, two threads can both read `active_requests = 5`, both compute `6`, and both write `6` -- one increment
is lost. `with lock:` calls `acquire()` on entry and `release()` on exit, even if an exception is raised.

```mermaid
sequenceDiagram
    box rgba(59,130,246,0.15) Request handler 1
        participant A as handler-1
    end
    box rgba(109,40,217,0.15) Request handler 2
        participant B as handler-2
    end
    box rgba(185,28,28,0.15) Lock
        participant L as request_lock
    end

    A->>L: acquire()
    activate L
    B->>L: acquire() (blocks)
    rect rgba(59,130,246,0.08)
        Note over A,L: handler-1 in critical section
        A->>L: release()
        deactivate L
    end
    Note over B: unblocked
    B->>L: acquire()
    activate L
    rect rgba(109,40,217,0.08)
        Note over B,L: handler-2 in critical section
        B->>L: release()
        deactivate L
    end
```

### Barrier

A [`Barrier(n)`](https://docs.python.org/3/library/threading.html#threading.Barrier) is a starting gate for `n` threads.
The first `n - 1` arrivals block; when the `n`-th calls `wait()`, the Barrier releases all of them at once. Reach for it
when threads have to hit a checkpoint together before any can move on.

A data pipeline that runs three parallel preprocessing steps before the merge phase:

```python
import threading

merge_barrier = threading.Barrier(3)


def preprocess_shard(shard_id: int, data: list[str]) -> list[str]:
    # ... expensive transformation ...
    results = [line.upper() for line in data]
    merge_barrier.wait()  # wait for all three shards to finish
    return results  # all shards proceed to merge simultaneously
```

```mermaid
sequenceDiagram
    box rgba(59,130,246,0.15) Shard workers
        participant S1 as shard-1
        participant S2 as shard-2
        participant S3 as shard-3
    end
    box rgba(185,28,28,0.15) Barrier
        participant Bar as merge_barrier
    end

    S1->>Bar: wait()
    activate Bar
    S3->>Bar: wait()
    S2->>Bar: wait() (last arrival, opens)
    deactivate Bar
    Bar-->>S1: released
    Bar-->>S3: released
    Bar-->>S2: released
```

### RLock

An [`RLock`](https://docs.python.org/3/library/threading.html#threading.RLock) (reentrant lock) is a Lock that doesn't
deadlock against itself. The same thread can `acquire()` it any number of times. The lock tracks a counter and releases
for real once the counter hits zero. Reach for it when a locked method might call another locked method on the same
object:

```python
import threading

account_lock = threading.RLock()


def transfer(amount: int) -> None:
    with account_lock:
        validate(amount)  # also acquires account_lock -- fine with RLock


def validate(amount: int) -> None:
    with account_lock:  # reentrant: same thread, count goes 2 → 1 on exit
        if amount <= 0:
            raise ValueError("amount must be positive")
```

With a plain `Lock`, the second `acquire()` inside `validate` would deadlock because the same thread already holds it.

```mermaid
sequenceDiagram
    box rgba(59,130,246,0.15) Same thread
        participant T as transfer()
        participant V as validate()
    end
    box rgba(185,28,28,0.15) RLock
        participant R as account_lock
    end

    T->>R: acquire() (count: 0→1)
    activate R
    T->>V: calls validate()
    V->>R: acquire() (count: 1→2)
    Note over R: same thread, no block
    V->>R: release() (count: 2→1)
    T->>R: release() (count: 1→0)
    deactivate R
```

### Event

An [`Event`](https://docs.python.org/3/library/threading.html#threading.Event) is a one-way switch. It starts unset.
`wait()` blocks until someone calls `set()`; `set()` unblocks every waiter at once; `clear()` flips it back. Reach for
it to signal "the system is ready, you may now proceed."

A background configuration loader that signals workers when startup is complete:

```python
import threading

config_ready = threading.Event()
config: dict[str, str] = {}


def loader() -> None:
    config.update({"db_host": "localhost", "db_port": "5432"})
    config_ready.set()  # unblocks all waiting workers


def worker(name: str) -> None:
    config_ready.wait()  # blocks until loader calls set()
    print(f"{name} connecting to {config['db_host']}")
```

```mermaid
sequenceDiagram
    box rgba(109,40,217,0.15) Workers
        participant W1 as worker-1
        participant W2 as worker-2
    end
    box rgba(185,28,28,0.15) Event
        participant E as config_ready
    end
    box rgba(5,150,105,0.15) Loader
        participant L as loader()
    end

    W1->>E: wait() (blocks)
    activate E
    W2->>E: wait() (blocks)
    L->>E: set()
    deactivate E
    Note over W1,W2: both unblocked simultaneously
    W1->>W1: connect to db
    W2->>W2: connect to db
```

### Condition

A [`Condition`](https://docs.python.org/3/library/threading.html#threading.Condition) is a lock plus a way to wait for
state to change. `wait()` releases the lock and sleeps; another thread changes state and calls `notify()` or
`notify_all()`; the sleeper wakes, reacquires the lock, and rechecks. Reach for it in producer-consumer patterns where
consumers must sleep when the queue is empty.

```python
import threading
from collections import deque

queue: deque[str] = deque()
queue_condition = threading.Condition()


def producer() -> None:
    with queue_condition:
        queue.append("task")
        queue_condition.notify()  # wake one waiting consumer


def consumer() -> None:
    with queue_condition:
        while not queue:
            queue_condition.wait()  # release lock, sleep, reacquire on wake
        task = queue.popleft()
    print(f"processing {task}")
```

```mermaid
sequenceDiagram
    box rgba(109,40,217,0.15) Consumer
        participant C as consumer()
    end
    box rgba(5,150,105,0.15) Producer
        participant P as producer()
    end
    box rgba(185,28,28,0.15) Condition
        participant Cond as queue_condition
    end

    C->>Cond: acquire()
    C->>Cond: wait() (queue empty, releases lock)
    activate Cond
    P->>Cond: acquire()
    P->>Cond: append task
    P->>Cond: notify()
    P->>Cond: release()
    deactivate Cond
    Note over C: re-acquires lock, sees task
    C->>Cond: release()
```

### Semaphore

A [`Semaphore(n)`](https://docs.python.org/3/library/threading.html#threading.Semaphore) is a counter. It starts at `n`.
`acquire()` decrements it (blocking when it hits zero); `release()` increments. Up to `n` threads can hold it at once.
Reach for it to cap a bounded resource: a connection pool, a parallelism limit.

A connection pool that limits concurrent database connections to 5:

```python
import threading

connection_semaphore = threading.Semaphore(5)


def query_database(sql: str) -> str:
    with connection_semaphore:  # blocks if 5 connections already active
        # ... execute query ...
        return "result"
```

```mermaid
sequenceDiagram
    box rgba(59,130,246,0.15) Queries
        participant Q1 as query-1
        participant Q2 as query-2
        participant Q3 as query-3
    end
    box rgba(185,28,28,0.15) Semaphore
        participant S as connection_sem
    end

    Q1->>S: acquire() (count: 2→1)
    activate S
    Q2->>S: acquire() (count: 1→0)
    Q3->>S: acquire() (blocks, count=0)
    Note over Q1: executes query
    Q1->>S: release() (count: 0→1)
    Note over Q3: unblocked
    Q3->>S: acquire() (count: 1→0)
    Q2->>S: release() (count: 0→1)
    Q3->>S: release() (count: 1→2)
    deactivate S
```

### BoundedSemaphore

A [`BoundedSemaphore(n)`](https://docs.python.org/3/library/threading.html#threading.BoundedSemaphore) is a `Semaphore`
that refuses to drift above its initial value. Call `release()` one too many times and it raises `ValueError`. A plain
`Semaphore` lets the counter climb past the cap, leaving the limit broken for the rest of the program. Reach for it when
stray releases should raise an exception rather than corrupt state.

A rate limiter that prevents more than 2 concurrent API calls:

```python
import threading

rate_limiter = threading.BoundedSemaphore(2)


def call_api(endpoint: str) -> str:
    with rate_limiter:
        # ... at most 2 threads here at once ...
        return "response"


# A bug: releasing without a matching acquire
rate_limiter.release()  # raises ValueError: semaphore released too many times
```

```mermaid
sequenceDiagram
    box rgba(59,130,246,0.15) Callers
        participant C1 as caller-1
        participant C2 as caller-2
        participant C3 as caller-3
    end
    box rgba(185,28,28,0.15) BoundedSemaphore
        participant BS as rate_limiter
    end

    C1->>BS: acquire() (count: 2→1)
    activate BS
    C2->>BS: acquire() (count: 1→0)
    C3->>BS: acquire() (blocks)
    C1->>BS: release() (count: 0→1)
    Note over C3: unblocked
    C3->>BS: acquire() (count: 1→0)
    C2->>BS: release() (count: 0→1)
    C3->>BS: release() (count: 1→2)
    deactivate BS
    C1->>BS: release() (count would exceed 2)
    Note over BS: ValueError raised immediately
```

---

Each of these primitives is non-deterministic by design. The OS scheduler picks which thread acquires a contended `Lock`
first, which order a `Barrier` releases its waiters, which `Condition` waiter `notify()` wakes; it picks differently
each run. Production code relies on that flexibility: a lock exists to resolve contention without callers specifying an
order. As Edward Lee put it in
[_The Problem with Threads_](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2006/EECS-2006-1.pdf): _"threads represent a
huge step. They discard the most essential and appealing properties of sequential computation: understandability,
predictability, and determinism."_

## Why multithreaded Python tests are flaky

Three threads share a lock and a barrier:

```python
import random
import threading

lock = threading.Lock()
barrier = threading.Barrier(3)


def worker(name: str) -> None:
    with lock:
        print(f"worker {name} got the lock")
    barrier.wait()
    print(f"worker {name} is past the barrier")


threads: list[threading.Thread] = [
    threading.Thread(target=worker, args=(n,)) for n in ("A", "B", "C")
]
random.shuffle(threads)
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
```

Run it five times, get five different outputs. The OS scheduler picks who gets the lock first, who exits the barrier
first. That's 6 possible lock orderings times 6 possible barrier orderings -- 36 distinct executions, and you control
none of them.

```mermaid
flowchart LR
    subgraph OS["OS Scheduler (you have no control)"]
        direction TB
        S[Schedule Decision]
    end

    A[Thread A<br>lock.acquire] --> S
    B[Thread B<br>lock.acquire] --> S
    C[Thread C<br>lock.acquire] --> S
    S --> Winner["??? Winner ???"]

    style OS fill:#dc2626,stroke:#b91c1c,color:#fff
    style A fill:#3b82f6,stroke:#2563eb,color:#fff
    style B fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style C fill:#f59e0b,stroke:#d97706,color:#fff
    style Winner fill:#dc2626,stroke:#b91c1c,color:#fff
```

Now imagine this isn't a toy example but a connection pool, a cache invalidation layer, or a task queue. The bug shows
up only when thread B acquires the lock _before_ thread A has released its resource. You can't write a regression test
for that because you can't tell the OS "run B next."

### The GIL used to hide this

The [Global Interpreter Lock](https://docs.python.org/3/glossary.html#term-GIL) masked many threading bugs for decades.
The GIL ensures only one thread executes Python bytecode at a time, which means operations like `dict[key] = value` or
`list.append(x)` are effectively atomic. Code that was "thread-unsafe" in theory often worked fine in practice because
the GIL serialized everything.

```mermaid
flowchart LR
    subgraph GIL["With GIL (Python ≤ 3.12 default)"]
        direction LR
        T1[Thread A executes] --> T2[Thread B executes] --> T3[Thread A executes]
    end

    subgraph NoGIL["Without GIL (Python 3.13+ free-threaded)"]
        direction LR
        P1[Thread A executes]
        P2[Thread B executes]
        P3[Thread C executes]
    end

    style GIL fill:#059669,stroke:#047857,color:#fff
    style NoGIL fill:#dc2626,stroke:#b91c1c,color:#fff
    style T1 fill:#50b432,stroke:#3d8a26,color:#fff
    style T2 fill:#50b432,stroke:#3d8a26,color:#fff
    style T3 fill:#50b432,stroke:#3d8a26,color:#fff
    style P1 fill:#ef4444,stroke:#dc2626,color:#fff
    style P2 fill:#ef4444,stroke:#dc2626,color:#fff
    style P3 fill:#ef4444,stroke:#dc2626,color:#fff
```

That era is ending. [PEP 703](https://peps.python.org/pep-0703/) made the GIL optional, Python 3.13 shipped the first
experimental free-threaded build, [Python 3.14 officially supports it](https://docs.python.org/3.14/whatsnew/3.14.html)
(with the performance penalty down to roughly 5-10%), and
[Python 3.15 adds stable ABI support for free-threaded builds](https://docs.python.org/3.15/whatsnew/3.15.html) along
with new threading utilities like
[`serialize_iterator`](https://docs.python.org/3.15/library/threading.html#threading.serialize_iterator) and
[`concurrent_tee`](https://docs.python.org/3.15/library/threading.html#threading.concurrent_tee). Code that relied on
implicit GIL serialization will start breaking.

```mermaid
timeline
    title Free-Threaded Python Timeline
    2023 : PEP 703 accepted
    2024 : Python 3.13 — experimental free-threaded build
    2025 : Python 3.14 — officially supported, 5-10% overhead
    2026 : Python 3.15 — stable ABI (abi3t), new threading utils, Tachyon profiler
```

## Enter blanket: deterministic threading control

[blanket](https://pypi.org/project/blanket/) (v1.0, MIT license, Python 3.11+) replaces your `threading` synchronization
primitives with wrapped versions that **stop and wait for instructions** instead of making their own scheduling
decisions.

```mermaid
flowchart LR
    subgraph Blanket["blanket Scheduler (YOU have control)"]
        direction TB
        S[Your Test Code]
    end

    A[Thread A<br>lock.acquire] --> S
    B[Thread B<br>lock.acquire] --> S
    C[Thread C<br>lock.acquire] --> S
    S -->|"relay(B, A, C)"| Winner["B gets lock first"]

    style Blanket fill:#059669,stroke:#047857,color:#fff
    style A fill:#3b82f6,stroke:#2563eb,color:#fff
    style B fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style C fill:#f59e0b,stroke:#d97706,color:#fff
    style Winner fill:#50b432,stroke:#3d8a26,color:#fff
    style S fill:#059669,stroke:#047857,color:#fff
```

The same three-thread example, rewritten with blanket:

```python
import blanket
from threading import Thread

scenario = blanket.Scenario()

lock = scenario.Lock()
barrier = scenario.Barrier(3)


def worker(name: str) -> None:
    with lock:
        print(f"worker {name} got the lock")
    barrier.wait()
    print(f"worker {name} is past the barrier")


thread_a: Thread = Thread(target=worker, args=("A",))
thread_b: Thread = Thread(target=worker, args=("B",))
thread_c: Thread = Thread(target=worker, args=("C",))

lock_api = scenario.api(lock)
barrier_api = scenario.api(barrier)

with scenario:
    for th in [thread_a, thread_b, thread_c]:
        th.start()
    list(lock_api.relay(thread_b, thread_a, thread_c))
    lock_api.unblock(lock.release, thread_c)
    with barrier_api.cycle(thread_c, thread_a, thread_b):
        pass

for th in [thread_a, thread_b, thread_c]:
    th.join()
```

Every single run produces:

```
worker B got the lock
worker A got the lock
worker C got the lock
worker C is past the barrier
worker A is past the barrier
worker B is past the barrier
```

The changes are minimal:

1. Create a `Scenario`.
2. Replace `threading.Lock()` with `scenario.Lock()` and `threading.Barrier(3)` with `scenario.Barrier(3)`.
3. Enter `with scenario:` -- your main thread becomes _the scheduler_.
4. Use `relay` to control lock acquisition order and `cycle` to control barrier exit order.

The worker code is _unchanged_. It still does `with lock:` and `barrier.wait()` like it would in production. The workers
have no idea they're being orchestrated.

Larry borrows Java's vocabulary for the mechanism. When a worker calls a blanket method, the primitive **parks** the
thread until the scheduler issues a **permit** to proceed. The linearized sequence of permits the scheduler hands out is
the scenario's **tempo**. The move in a blanket test, as he puts it, is to "decide what the tempo should be, then make
it so." The README's motto says it shorter:

> _Your test should be effectively single-threaded. If it isn't, you haven't blanketed hard enough. Slow it down._

## Wrapping, not reimplementing

blanket wraps real `threading` primitives rather than reimplementing them. When you call `lock.acquire()` on a blanket
Lock, it calls the real `threading.Lock.acquire()` underneath. When you call `condition.wait()`, the real
`threading.Condition.wait()` executes, with all its semantics around releasing and reacquiring the underlying lock.

If a testing framework reimplements `Lock.acquire()` and gets some edge case wrong, your tests pass but production
breaks. blanket avoids this entirely. The semantics come straight from CPython's `threading` module.

> _blanket has no opinion about what synchronization primitives mean. It does no reimplementation. Every
> `lock.acquire()` is a real `threading.Lock.acquire()` underneath._

## How it works under the hood

### The transaction state machine

Every method call on a blanket primitive becomes a **transaction** -- a state machine:

```mermaid
flowchart TB
    START(( )) --> BLOCKED
    BLOCKED -->|"unblock"| COMMIT
    BLOCKED -->|"unblock (no timeout)"| WAITING
    COMMIT -->|"proceed"| WAITING
    WAITING -->|"primitive wakes"| STALLED
    STALLED -->|"unstall"| RESUMED
    RESUMED --> COMMITTED
    COMMITTED -->|"pause requested"| PAUSED
    COMMITTED -->|"no pause"| EXITING
    PAUSED -->|"unpause"| EXITING
    EXITING -->|"success"| RETURNED
    EXITING -->|"exception"| RAISED

    style BLOCKED fill:#dc2626,stroke:#b91c1c,color:#fff
    style COMMIT fill:#f59e0b,stroke:#d97706,color:#fff
    style WAITING fill:#6366f1,stroke:#4f46e5,color:#fff
    style STALLED fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style PAUSED fill:#ec4899,stroke:#db2777,color:#fff
    style RETURNED fill:#059669,stroke:#047857,color:#fff
    style RAISED fill:#dc2626,stroke:#b91c1c,color:#fff
```

Four **parking states** exist where the transaction stops and waits:

```mermaid
flowchart TB
    subgraph Parking["Parking States"]
        direction TB
        B["BLOCKED<br><i>Scheduler Block</i><br>Before anything happens"]
        C["COMMIT<br><i>Timeout Decision</i><br>For timeout-bearing calls"]
        W["WAITING<br><i>Real Primitive Wait</i><br>Not under blanket control"]
        S["STALLED<br><i>Scheduler Stall</i><br>After wake, before proceed"]
        P["PAUSED<br><i>Scheduler Pause</i><br>General-purpose hold"]
    end

    B -->|"scheduler: unblock()"| C
    C -->|"real primitive call"| W
    W -->|"primitive wakes thread"| S
    S -->|"scheduler: unstall()"| P

    style B fill:#dc2626,stroke:#b91c1c,color:#fff
    style C fill:#f59e0b,stroke:#d97706,color:#fff
    style W fill:#6366f1,stroke:#4f46e5,color:#fff
    style S fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style P fill:#ec4899,stroke:#db2777,color:#fff
```

- **BLOCKED** (the _scheduler block_): before anything happens. Every transaction starts here.
- **COMMIT**: for timeout-bearing calls (like `lock.acquire(timeout=5)`). The scheduler can force a timeout or ignore
  it.
- **WAITING**: inside the real primitive's wait. Not under blanket's control -- it's the real `threading.Lock` doing its
  thing.
- **STALLED**: after waking from the real wait but before proceeding.
- **PAUSED**: a general-purpose pause point.

When thread B calls `lock.acquire()`, blanket creates a transaction in `BLOCKED` state and puts B to sleep. The
scheduler sees the transaction, calls `transaction.unblock()`, and B wakes up to actually acquire the lock.

### The four-object architecture

Each blanket primitive is four objects:

```mermaid
flowchart TB
    subgraph Scenario["Scenario"]
        direction TB
        subgraph Objects["Per-Primitive Objects"]
            PH["Primitive Handle<br><i>masquerades as threading.Lock</i><br>Workers use this"]
            API["API Object<br><i>scheduler-facing</i><br>relay(), assign(), cycle()"]
            RAW["Raw Handle<br><i>always unregulated</i><br>Bypass scheduling"]
            CORE["Core (internal)<br><i>actual state + logic</i><br>Manages transactions"]
        end
    end

    PH -->|"calls route through"| CORE
    API -->|"controls"| CORE
    RAW -->|"direct access"| CORE

    style PH fill:#3b82f6,stroke:#2563eb,color:#fff
    style API fill:#059669,stroke:#047857,color:#fff
    style RAW fill:#f59e0b,stroke:#d97706,color:#fff
    style CORE fill:#6366f1,stroke:#4f46e5,color:#fff
```

- **Primitive Handle**: what workers use. Masquerades as a real `threading.Lock` (passes `isinstance` checks).
- **API Object**: what the scheduler uses. Provides `relay()`, `assign()`, `cycle()`, `allocate()`.
- **Raw Handle**: always unregulated. Use inside `with scenario:` when the scheduler itself needs to call the primitive.
- **Core**: internal. You never touch this directly.

### Masquerading

`isinstance(scenario.Lock(), threading.Lock)` returns `True`. The `repr()` looks identical to a real lock's. One subtle
tell: blanket uppercases the hex ID. A real lock shows `0x78c990475650`; a blanket lock shows `0X78C9905B2CF0`.

## The three API layers

blanket's API has three layers, each built on the one below. The high-level helpers handle common patterns in one call.
When those don't fit, drop to the middle level for manual step-by-step control. The low level exposes raw transactions
and signal-based waiting for cases that need more precision.

```mermaid
flowchart LR
    subgraph High["High-Level"]
        direction TB
        H1["relay()  assign()"]
        H2["cycle()  allocate()"]
    end

    subgraph Mid["Middle-Level"]
        direction TB
        M1["park()  skip()  finish()"]
        M2["Driver / Chain / Dispatch"]
    end

    subgraph Low["Low-Level"]
        direction TB
        L1["transactions"]
        L2["scenario.wait() + signals"]
    end

    High -->|"uses"| Mid -->|"uses"| Low

    style High fill:#059669,stroke:#047857,color:#fff
    style Mid fill:#f59e0b,stroke:#d97706,color:#fff
    style Low fill:#dc2626,stroke:#b91c1c,color:#fff
    style H1 fill:#059669,stroke:#047857,color:#fff
    style H2 fill:#059669,stroke:#047857,color:#fff
    style M1 fill:#f59e0b,stroke:#d97706,color:#fff
    style M2 fill:#f59e0b,stroke:#d97706,color:#fff
    style L1 fill:#dc2626,stroke:#b91c1c,color:#fff
    style L2 fill:#dc2626,stroke:#b91c1c,color:#fff
```

### Low-level: transactions and scenario.wait

Raw transactions and `scenario.wait(*items)` -- a universal blocking function modeled after Win32's
[`WaitForMultipleObjects`](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitformultipleobjects).
You can wait on threads, transactions, bound methods, or signal tokens:

```python
from blanket import Call, Reached, State, Terminated

with scenario:
    signaled: set[object] = scenario.wait(
        Call(lock.acquire, thread_a), Terminated(thread_b)
    )
```

### Middle-level: park, skip, finish, and drivers

Drives threads through sequences of method calls:

```python
with scenario:
    result: dict[Thread, object] = scenario.park(thread_a, lock.acquire)
    result[thread_a].unblock()

    scenario.skip(thread_b, lock.acquire, lock.release)
    scenario.finish(thread_c)
```

For multi-thread orchestration, `Driver`, `Chain`, and `Dispatch` provide lazy imperative control:

```python
with scenario:
    d1 = scenario.Driver(thread_a)
    d2 = scenario.Driver(thread_b)
    d1.skip()
    d2.skip()
    dispatch = scenario.Dispatch()
    dispatch.add(d1)
    dispatch.add(d2)
    for driver in dispatch:
        driver.skip()
```

### High-level: per-primitive helpers

Where you'll spend most of your time:

## Tutorial: real-world examples

### Connection pool: who gets the next connection

A connection pool protects its internal list with a lock. Three request handlers call `get_connection()` concurrently. A
bug report says handler B sometimes gets a stale connection when it acquires the pool lock before handler A has returned
its connection. With `relay`, force that exact ordering:

```python
import blanket
from threading import Thread

scenario = blanket.Scenario()
pool_lock = scenario.Lock()
connections: list[str] = ["conn_1", "conn_2"]
handed_out: list[str] = []


def get_connection(handler_name: str) -> None:
    with pool_lock:
        if connections:
            conn = connections.pop(0)
            handed_out.append(f"{handler_name}={conn}")


handler_a: Thread = scenario.thread(get_connection, "handler_a")
handler_b: Thread = scenario.thread(get_connection, "handler_b")
handler_c: Thread = scenario.thread(get_connection, "handler_c")

pool_api = scenario.api(pool_lock)

with scenario:
    for thread in pool_api.relay(handler_b, handler_a, handler_c):
        pass
    pool_api.unblock(pool_lock.release, handler_c)

assert handed_out == ["handler_b=conn_1", "handler_a=conn_2"]
```

```mermaid
sequenceDiagram
    box rgba(5,150,105,0.15) Scheduler
        participant S as Scheduler
    end
    box rgba(109,40,217,0.15) Handlers
        participant HB as handler_b
        participant HA as handler_a
        participant HC as handler_c
    end
    box rgba(185,28,28,0.15) Pool
        participant P as pool_lock
    end

    Note over S: with scenario:
    HB->>P: acquire() - BLOCKED
    HA->>P: acquire() - BLOCKED
    HC->>P: acquire() - BLOCKED

    S->>HB: unblock via relay
    HB->>P: acquire() succeeds
    Note over HB: pops conn_1
    HB->>P: release()

    S->>HA: unblock via relay
    HA->>P: acquire() succeeds
    Note over HA: pops conn_2
    HA->>P: release()

    S->>HC: unblock via relay
    HC->>P: acquire() succeeds
    Note over HC: pool empty, no conn
    HC->>P: release()
```

### Database migration: reproducing a deadlock

Two migration tasks each acquire locks in opposite order. Once in a thousand runs they deadlock. Without blanket you'd
loop the test hoping to get lucky. With blanket, force task 1 to hold the users lock while task 2 holds the orders lock,
then have each reach for the other's:

```python
import blanket
from threading import Thread

scenario = blanket.Scenario()
users_lock = scenario.Lock()
orders_lock = scenario.Lock()


def migrate_users() -> None:
    users_lock.acquire()
    if orders_lock.acquire(timeout=1.0):
        orders_lock.release()
    users_lock.release()


def migrate_orders() -> None:
    orders_lock.acquire()
    if users_lock.acquire(timeout=1.0):
        users_lock.release()
    orders_lock.release()


users_task: Thread = scenario.thread(migrate_users)
orders_task: Thread = scenario.thread(migrate_orders)

users_api = scenario.api(users_lock)
orders_api = scenario.api(orders_lock)

with scenario:
    users_api.assign(users_task)
    orders_api.assign(orders_task)

    parked_users = scenario.park(users_task, orders_lock.acquire)
    parked_orders = scenario.park(orders_task, users_lock.acquire)

    parked_users[users_task].expire()
    parked_users[users_task].unblock()
    scenario.finish(users_task)
    scenario.finish(orders_task)
```

```mermaid
sequenceDiagram
    box rgba(5,150,105,0.15) Scheduler
        participant S as Scheduler
    end
    box rgba(59,130,246,0.15) Migration tasks
        participant UT as users_task
        participant OT as orders_task
    end
    box rgba(185,28,28,0.15) Locks
        participant UL as users_lock
        participant OL as orders_lock
    end

    S->>UL: assign users_task
    activate UL
    S->>OL: assign orders_task
    activate OL

    UT->>OL: acquire(timeout=1.0) (BLOCKED)
    OT->>UL: acquire(timeout=1.0) (BLOCKED)
    Note over UT,OT: Deadlock: each holds one lock, wants the other

    S->>UT: expire() + unblock()
    Note over UT: timeout fires, returns False
    deactivate UL
    S->>OT: finish
    deactivate OL
```

### Service startup: controlling initialization order

A service spawns background workers that block on a "ready" event until configuration loads. A race in the health check
means the HTTP listener must start _after_ the schema migration worker finishes. Force the migration to resume first:

```python
import blanket
from threading import Thread

scenario = blanket.Scenario()
ready = scenario.Event()
startup_order: list[str] = []


def schema_migrator() -> None:
    ready.wait()
    startup_order.append("migration")


def http_listener() -> None:
    ready.wait()
    startup_order.append("http")


def config_loader() -> None:
    ready.set()


migrator: Thread = scenario.thread(schema_migrator)
listener: Thread = scenario.thread(http_listener)
loader: Thread = scenario.thread(config_loader)
ready_api = scenario.api(ready)

with scenario:
    with ready_api.cycle(migrator, listener, loader) as cyc:
        cyc.wake(migrator, listener)

assert startup_order == ["migration", "http"]
```

`cycle` drives `migrator` and `listener` into `ready.wait()`, then drives `loader` through `ready.set()` (waking both),
and gives you control over who resumes first. Without blanket the wake order is OS-determined.

```mermaid
sequenceDiagram
    box rgba(5,150,105,0.15) Scheduler
        participant S as Scheduler
    end
    box rgba(109,40,217,0.15) Workers
        participant M as migrator
        participant L as listener
        participant C as config_loader
    end
    box rgba(245,158,11,0.15) Event
        participant E as ready event
    end

    M->>E: wait()
    activate E
    L->>E: wait()
    C->>E: set() (wakes both)
    deactivate E

    Note over S: cyc.wake(migrator, listener)
    S->>M: resume first
    Note over M: startup_order.append("migration")
    S->>L: resume second
    Note over L: startup_order.append("http")
```

### Map-reduce: controlling shard completion order

Three shard processors reach a barrier before the reduce phase. A bug in the reducer only triggers when shard C's
partial results are merged before shard A's. Force that ordering to write a regression test:

```python
import blanket
from threading import Thread

scenario = blanket.Scenario()
sync_point = scenario.Barrier(3)
reduce_input: list[str] = []


def process_shard(shard_id: str) -> None:
    sync_point.wait()
    reduce_input.append(shard_id)


shard_a: Thread = scenario.thread(process_shard, "shard_a")
shard_b: Thread = scenario.thread(process_shard, "shard_b")
shard_c: Thread = scenario.thread(process_shard, "shard_c")

barrier_api = scenario.api(sync_point)

with scenario:
    with barrier_api.cycle(shard_a, shard_b, shard_c) as cyc:
        cyc.wake(shard_c, shard_b, shard_a)

assert reduce_input == ["shard_c", "shard_b", "shard_a"]
```

### Connection retry: testing the timeout fallback

Your pool has retry logic: if `acquire(timeout=5.0)` fails, it falls back to creating a fresh connection. That timeout
path is nearly impossible to trigger in tests because you'd need to hold the lock for 5 real seconds. `tx.expire()`
fires the timeout instantly:

```python
import blanket
from threading import Thread

scenario = blanket.Scenario()
pool_lock = scenario.Lock()
used_fallback: bool = False


def get_or_create_connection() -> None:
    global used_fallback
    if not pool_lock.acquire(timeout=5.0):
        used_fallback = True


pool_lock.acquire()  # simulate a long-running transaction holding the lock

retry_thread: Thread = scenario.thread(get_or_create_connection)

with scenario:
    parked = scenario.park(retry_thread, pool_lock.acquire)
    tx = parked[retry_thread]
    tx.expire()
    tx.unblock()
    scenario.finish(retry_thread)

assert used_fallback is True
```

`tx.expire()` forces the timeout to fire immediately. `tx.disregard()` does the opposite -- pretends no timeout was
specified.

### Monkey-patching code you don't own

When the code under test creates its own locks internally, `inject` swaps them for blanket primitives so you can still
control scheduling:

```python
import blanket
import connection_pool  # module that does `import threading` internally
from threading import Thread

scenario = blanket.Scenario()

with scenario.inject(connection_pool):
    pool = connection_pool.ConnectionPool(max_size=2)
    # All threading.Lock() calls inside connection_pool now create blanket locks

    results: dict[str, object] = {}

    def getter(name: str) -> None:
        results[name] = pool.get_connection()

    getter_a: Thread = scenario.thread(getter, "A")
    getter_b: Thread = scenario.thread(getter, "B")

    with scenario:
        pass  # orchestrate as needed
```

`inject` handles both `from threading import Lock` and `import threading` patterns. It returns a context manager; on
exit, original references are restored.

### Cache update race: injecting sync points into lockless code

Some code skips locks entirely, relying on Python's bytecode-level atomicity for `dict[key] = value`. Under
free-threading that's no longer safe. The bytecode injector lets you insert a synchronization checkpoint between two
operations so you can interleave another thread's read between them:

```python
import threading

from blanket.injector import Location, inject_call


def update_cache(cache: dict[str, str], key: str, value: str) -> None:
    old: str | None = cache.get(key)
    new_value: str = f"{old}_{value}" if old else value
    cache[key] = new_value  # race between the read above and this write


checkpoint = threading.Event()


def pause() -> None:
    checkpoint.wait()


loc = Location.text(update_cache, "cache[key] = new_value")
patched_update = inject_call(pause, loc)
# patched_update pauses right before the write, letting you interleave another thread
```

## A complete test suite example: thread-safe LRU cache

Testing a thread-safe LRU cache:

```python
import threading
from collections import OrderedDict
from typing import Generic, TypeVar

V = TypeVar("V")


class ThreadSafeLRUCache(Generic[V]):
    def __init__(self, max_size: int) -> None:
        self._lock: threading.Lock = threading.Lock()
        self._cache: OrderedDict[str, V] = OrderedDict()
        self._max_size: int = max_size

    def get(self, key: str) -> V | None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            return None

    def put(self, key: str, value: V) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self._max_size:
                self._cache.popitem(last=False)
```

The tests:

```python
from collections import OrderedDict
from threading import Thread

import blanket


def test_write_before_read() -> None:
    scenario = blanket.Scenario()
    lock = scenario.Lock()

    cache: OrderedDict[str, str] = OrderedDict({"x": "old"})
    results: dict[str, str] = {}

    def getter() -> None:
        with lock:
            if "x" in cache:
                cache.move_to_end("x")
                results["read"] = cache["x"]

    def putter() -> None:
        with lock:
            cache["x"] = "new"
            cache.move_to_end("x")

    getter_thread: Thread = scenario.thread(getter)
    putter_thread: Thread = scenario.thread(putter)
    lock_api = scenario.api(lock)

    with scenario:
        list(lock_api.relay(putter_thread, getter_thread))
        lock_api.unblock(lock.release, getter_thread)

    assert results["read"] == "new"


def test_eviction_order() -> None:
    scenario = blanket.Scenario()
    lock = scenario.Lock()
    max_size: int = 2

    cache: OrderedDict[str, int] = OrderedDict({"a": 1, "b": 2})

    def put_c() -> None:
        with lock:
            cache["c"] = 3
            if len(cache) > max_size:
                cache.popitem(last=False)

    def put_d() -> None:
        with lock:
            cache["d"] = 4
            if len(cache) > max_size:
                cache.popitem(last=False)

    writer_c: Thread = scenario.thread(put_c)
    writer_d: Thread = scenario.thread(put_d)
    lock_api = scenario.api(lock)

    with scenario:
        list(lock_api.relay(writer_c, writer_d))
        lock_api.unblock(lock.release, writer_d)

    assert list(cache.keys()) == ["c", "d"]


def test_read_prevents_eviction() -> None:
    scenario = blanket.Scenario()
    lock = scenario.Lock()
    max_size: int = 2

    cache: OrderedDict[str, int] = OrderedDict({"a": 1, "b": 2})

    def reader() -> None:
        with lock:
            if "a" in cache:
                cache.move_to_end("a")

    def writer() -> None:
        with lock:
            cache["c"] = 3
            if len(cache) > max_size:
                cache.popitem(last=False)

    reader_thread: Thread = scenario.thread(reader)
    writer_thread: Thread = scenario.thread(writer)
    lock_api = scenario.api(lock)

    with scenario:
        list(lock_api.relay(reader_thread, writer_thread))
        lock_api.unblock(lock.release, writer_thread)

    assert "a" in cache
    assert "b" not in cache
    assert "c" in cache
```

Each test forces one interleaving and asserts the exact outcome. No flakiness. 100% reproducible.

## Getting started with blanket

```bash
uv pip install blanket
```

Requires Python 3.11+ and depends on [big](https://github.com/larryhastings/big). The bytecode injector also needs the
[bytecode](https://pypi.org/project/bytecode/) package when you reach for it.

### The shape of every blanket test

Every blanket test follows three phases:

1. **Setup** -- create a `Scenario`, create the primitives, define worker functions, create threads (use
   `scenario.thread()` for managed threads that start and join automatically).
2. **Schedule** -- enter `with scenario:`. Your main thread becomes the scheduler. Call the high-level API (`relay`,
   `cycle`, `allocate`) to control execution order.
3. **Assert** -- after exiting `with scenario:`, blanket has joined all managed threads. Check results.

### Quick reference

| I want to...                                         | Use                                     |
| ---------------------------------------------------- | --------------------------------------- |
| Control which thread gets a lock next                | `lock_api.relay(A, B, C)`               |
| Transfer a lock from one thread to another           | `lock_api.assign(holder, acquirer)`     |
| Orchestrate wait/notify on a Condition               | `cond_api.cycle(waiter, notifier)`      |
| Control barrier exit order                           | `barrier_api.cycle(A, B, C)`            |
| Order semaphore acquires/releases                    | `sem_api.allocate(A, B, C)`             |
| Force a timeout to fire immediately                  | `tx.expire()` then `tx.unblock()`       |
| Ignore a timeout entirely                            | `tx.disregard()` then `tx.unblock()`    |
| Park a thread at a specific method                   | `scenario.park(thread, method)`         |
| Drive a thread through multiple calls                | `scenario.skip(thread, m1, m2, m3)`     |
| Drive a thread to termination                        | `scenario.finish(thread)`               |
| Use a primitive without regulation (inside scenario) | `scenario.raw(primitive)`               |
| Test code that creates its own locks                 | `scenario.inject(module)`               |
| Add sync points to lockless code                     | `blanket.injector.inject_call(fn, loc)` |

## Common pitfalls

- **Calling a blanket primitive outside `with scenario:`**. The primitives need an active scheduler. Outside the block
  they hang or raise.
- **Skipping `scenario.api(primitive)`**. The high-level helpers (`relay`, `cycle`, `allocate`) live on the API object,
  not on the primitive handle the workers use.
- **Calling a regulated primitive from your scheduler code**. The scheduler thread holds the scenario; a regulated call
  from it parks against itself. Use `scenario.raw(primitive)` to bypass regulation when the scheduler needs to touch a
  primitive directly.
- **Forgetting `tx.unblock()` after `tx.expire()`**. `expire()` arms the timeout. The transaction stays parked until
  `unblock()` releases it.
- **Mixing `scenario.thread(...)` with bare `threading.Thread`**. The scenario joins managed threads on exit; bare
  threads it doesn't know about can escape the block and race the scheduler.

## FAQ

- **Why is my multithreaded Python test flaky?** The test depends on which thread the OS scheduler picks next. The
  scheduler picks differently on each run, so a race condition that fires one time in a thousand stays one time in a
  thousand. blanket lets your test make the scheduling decisions instead.
- **How do I write a deterministic concurrency test in Python?** Wrap each `threading` primitive in its blanket
  counterpart inside a `Scenario`, then drive execution from the main thread with `relay`, `cycle`, or `assign`. Each
  method call on a blanket primitive parks until the scheduler issues a permit. Runs reproduce the same order.
- **How is blanket different from Loom, Shuttle, or Coyote?** Stateless model checkers explore many interleavings to
  discover bugs. blanket runs one interleaving you write by hand. The two approaches pair well: an SMC tool finds a
  race, you pin it with a blanket regression test.
- **Does blanket work with pytest?** Yes. A blanket test is a regular Python function that runs to completion. Put it
  inside a pytest test function and pytest reports pass or fail in the usual way.
- **Does blanket work with asyncio?** blanket targets the `threading` module. Tasks coordinated with asyncio primitives
  (`asyncio.Lock`, `asyncio.Event`) sit outside its scope. For deterministic asyncio tests, see
  [pytest-asyncio](https://pytest-asyncio.readthedocs.io/) and the asyncio event loop's own debug hooks.
- **Does blanket work with free-threaded Python?** Yes. blanket wraps the real `threading` primitives, so whatever
  semantics those primitives carry in your build (GIL or free-threaded) come along.
- **Can blanket find concurrency bugs automatically?** No. blanket reproduces a scenario you describe. To discover
  unknown races, pair it with [Hypothesis](https://hypothesis.readthedocs.io/) for property-based testing, a
  `ThreadSanitizer`-style runtime detector, or a stateless model checker.

## Concurrency testing tools, compared

Testing concurrent code has been tackled differently across ecosystems. Understanding where blanket fits helps you know
when to reach for it versus something else.

| Approach                     | Tools                                                                                                                                                                                                                                                                                                                                                                                   | How it works                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Bug discovery**            | [Loom](https://github.com/tokio-rs/loom) (Rust), [Shuttle](https://github.com/awslabs/shuttle) (Rust/AWS), [Coyote](https://microsoft.github.io/coyote/) (.NET), [Lincheck](https://github.com/JetBrains/lincheck) (JVM)                                                                                                                                                                | Run the test many times with different scheduling choices to systematically find interleavings that trigger bugs                  |
| **Runtime detection**        | [Go Race Detector](https://go.dev/blog/race-detector), [ThreadSanitizer](https://github.com/google/sanitizers) (C/C++)                                                                                                                                                                                                                                                                  | Instrument memory accesses and flag races as they happen in real runs                                                             |
| **Deterministic control**    | **blanket** (Python), [kotlinx-coroutines-test](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-test/) (Kotlin), [Thread Weaver](https://github.com/google/thread-weaver) (Java)                                                                                                                                                                                       | Declare the exact interleaving you want; the tool guarantees it executes that way                                                 |
| **Scenario generation**      | [Hypothesis](https://hypothesis.readthedocs.io/en/latest/stateful.html) (Python), [Jepsen](https://jepsen.io/) (distributed systems)                                                                                                                                                                                                                                                    | Generate test programs automatically from state machine rules or fault injection                                                  |
| **Deterministic simulation** | [FoundationDB](https://www.thestrangeloop.com/2014/testing-distributed-systems-w-slash-deterministic-simulation.html), [TigerBeetle](https://tigerbeetle.com/blog/2023-07-06-simulation-testing-for-liveness/), [Antithesis](https://antithesis.com/blog/is_something_bugging_you/), [WarpStream](https://www.warpstream.com/blog/deterministic-simulation-testing-for-our-entire-saas) | Run the system inside a virtualized event loop driven by a single RNG seed; reuse the seed to replay a known failure step by step |

### Stateless model checkers

The largest family uses
**[stateless model checking](https://en.wikipedia.org/wiki/Model_checking#Stateless_model_checking)** (SMC) -- running
code many times with different scheduling decisions to explore interleavings.

[Loom](https://github.com/tokio-rs/loom) (Rust) does exhaustive permutation testing under the
[C11 memory model](https://en.cppreference.com/w/c/language/memory_model):

```rust
use loom::sync::Arc;
use loom::sync::atomic::{AtomicUsize, Ordering};
use loom::thread;

#[test]
fn test_concurrent_increment() {
    loom::model(|| {
        let num = Arc::new(AtomicUsize::new(0));
        let num2 = num.clone();

        let t1 = thread::spawn(move || {
            num2.fetch_add(1, Ordering::SeqCst);
        });

        num.fetch_add(1, Ordering::SeqCst);
        t1.join().unwrap();

        assert_eq!(2, num.load(Ordering::SeqCst));
    });
}
```

Loom is _sound_ (if all explorations pass, the code is correct) but the number of interleavings grows exponentially.

[Shuttle](https://github.com/awslabs/shuttle) (Rust, AWS) trades completeness for scalability using randomized testing:

```rust
use shuttle::sync::Mutex;
use shuttle::thread;
use std::sync::Arc;

#[test]
fn shuttle_test() {
    shuttle::check_random(|| {
        let data = Arc::new(Mutex::new(0));
        let data2 = data.clone();

        let t = thread::spawn(move || {
            *data2.lock().unwrap() += 1;
        });

        *data.lock().unwrap() += 1;
        t.join().unwrap();

        assert_eq!(*data.lock().unwrap(), 2);
    }, 1000);
}
```

[Coyote](https://microsoft.github.io/coyote/) (Microsoft, .NET) uses binary rewriting and records schedules for replay.
Azure teams report finding bugs "in minutes that would have taken days with stress testing."

[Lincheck](https://github.com/JetBrains/lincheck) (JetBrains, JVM) tests concurrent data structures for
[linearizability](https://en.wikipedia.org/wiki/Linearizability):

```kotlin
class ConcurrentCounterTest {
    private val counter = ConcurrentCounter()

    @Operation fun increment() = counter.increment()
    @Operation fun get() = counter.get()

    @Test fun modelCheckingTest() = ModelCheckingOptions().check(this::class)
}
```

### Runtime detectors

[Go's Race Detector](https://go.dev/blog/race-detector), built on
[ThreadSanitizer](https://github.com/google/sanitizers), instruments every memory access:

```go
func main() {
    counter := 0
    var wg sync.WaitGroup
    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter++ // DATA RACE
        }()
    }
    wg.Wait()
}
```

```bash
$ go run -race main.go
WARNING: DATA RACE
Write at 0x00c0000b4010 by goroutine 7:
```

Catches races only when triggered. Adds ~10x overhead, so it's a CI tool, not production.

### Deterministic virtual time

[Kotlin's `kotlinx-coroutines-test`](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-test/) controls
_time_ rather than thread scheduling -- similar philosophy, different domain:

```kotlin
@Test
fun testTimeout() = runTest {
    val deferred = async {
        delay(1_000) // skipped, no real wait
        "result"
    }
    advanceTimeBy(1_000)
    assertEquals("result", deferred.await())
}
```

### Distributed systems

[Jepsen](https://jepsen.io/) injects network partitions, node crashes, and clock skew into distributed databases, then
checks consistency guarantees. Different level (distributed nodes vs. threads in one process) but same philosophy:
declare a failure scenario, force it, verify correctness.

### Where blanket fits

blanket doesn't explore interleavings automatically, detect races at runtime, or generate scenarios. It lets you declare
a specific interleaving by hand and guarantees it executes that way every time.

It shares the goal of deterministic replay with deterministic simulation testing
([FoundationDB](https://www.thestrangeloop.com/2014/testing-distributed-systems-w-slash-deterministic-simulation.html),
[TigerBeetle](https://tigerbeetle.com/blog/2023-07-06-simulation-testing-for-liveness/),
[Antithesis](https://antithesis.com/blog/is_something_bugging_you/)) and inverts the user model. DST's determinism is
seed-driven: you reuse an RNG seed to replay a failure that randomness once produced. blanket's is declarative: you
write the scenario you want, by hand. DST scales by exploring a state space. blanket scales as engineers encode specific
failures as regression tests.

Best for:

- **Regression tests for known bugs.** Pin the exact interleaving that triggers a bug. Fix it. Test stays green.
- **Coverage of rare code paths.** Force the sequence that triggers that one `except` branch.
- **Documentation of concurrency contracts.** A blanket test reads like a specification.

The trade-off: you have to know what scenario to test. blanket won't discover bugs, it reproduces ones you understand.
Ideal workflow: an SMC tool or DST harness finds bugs, blanket pins them as regression tests.

## Related reading

- [PyCon US 2026 Packaging Summit Recap](/posts/pycon-us-2026-packaging-summit-recap) and
  [Typing Summit Recap](/posts/pycon-us-2026-typing-summit-recap) for the rest of my PyCon US 2026 coverage.
- [PyTexas 2026 Recap](/posts/pytexas-2026-recap) for more on free-threading and the Python 3.14 rollout.

If you maintain a library that needs to work under free-threading, write new concurrent code, or want to pin down a
flaky test, run `uv pip install blanket` and try it.
