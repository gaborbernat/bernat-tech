+++
author = "Bernat Gabor"
date = 2019-02-07T13:41:03Z
description = ""
draft = false
image = "https://images.unsplash.com/photo-1453227588063-bb302b62f50b?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ"
slug = "growing-pain"
tags = ["python", "packaging", "pip", "setuptools", "pep517", "pep518"]
title = "Python packaging - Growing Pains"
+++

In my previous two posts I've went over
[what package types python has](https://www.bernat.tech/pep-517-and-python-packaging/), and
[how package building works](https://www.bernat.tech/pep-517-518/), especially with the introduction of the PEP-517/518.
Although the changes were primarily to make things more robust, while implementing it and releasing we did run in a few
issues. This post is going to go over a few, hopefully serving as lessons learned for all of us and presenting some
interesting problems to solve in the future.

Looking at the changes of PEP-517 and PEP-518 one can identify that build backends (aka setuptools, flit) had very
little to do, only to also expose their functionality via a python module. Most of the heavy work is on the build
frontend, that now needs to generate the isolated python and then invoke the build backends in a new way. When we're
talking about build frontends nowadays, our options are mostly pip or poetry (and tox for developers).

These projects are maintained by the community, by a handful of active developers, in their free time. They are not
getting paid for it, and they need to be careful to consider the myriad ways these tools are used. Considering this it's
not much of a surprise it took almost two years after the PEP acceptance to come out with a first implementation.
Planning, testing and implementation has been going on for over a year in the background.

Against all the preparations though, inevitably, the first release did break a few packages, mostly where people
performed some operations that caught the maintainers by surprise. Let's try to understand a few of these examples, and
how did they get addressed.

{{/*< figure src="https://images.unsplash.com/photo-1543892673-921992c933f5?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ" caption="Photo by <a href="https://unsplash.com/@minkmingle?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Mink Mingle</a> / <a href="https://unsplash.com/?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Unsplash</a> - ready to roll!" >*/}}

## PEP-518

The PEP introduces the [TOML file format.](https://github.com/toml-lang/toml) A format especially created to be easy to
read/write configurations. While packaging configuration is exposed under the `build-system` section, other tools are
free to put their configuration under the `tool:name` section, given they own the PyPi namespace for the name. Various
tools started to take advantage of this right away (such as [towncrier](https://pypi.org/project/towncrier/),
[black](https://pypi.org/project/black/), etc).

When [pip 18.0 (released 2018 July 22](https://pip.pypa.io/en/stable/news/#id61)) added support for PEP-518 packages
using the `pyproject.toml` initially broke, as the PEP-518 mandated that all packages having the `pyproject.toml`
**must** specify the `build-backend` section. But packages beforehand used it only as a configuration file for these
other projects, since they didn't specify it pre-emptively, when pip ran into these files, it just raised errors
complaining of invalid `pyproject.toml` files.

## PEP-517

### The pip wheel cache issue.

The way pip installs in a PEP-517 world is to first generate a wheel and then extract that. To be in PEP-517 world one
**must** specify the `build-backend` key, otherwise all frontends per specification need to fallback to using the
`setup.py` commands.

When pip builds wheels it does it by default via a caching system. This is a speed-up mechanism so that if multiple
virtual environments need the same wheel we don't keep rebuilding it, but instead re-use it. The PEP-517 wheel build
operation also takes advantage of this.

This becomes troublesome though when you disable the cache. Now there's no target folder where to build the wheel. So
the build itself fails, [see the attached issue.](https://github.com/pypa/pip/issues/6158) The issue manifested early
though, but en masse, as most CI systems run with this option turned on, just a day later pip 19.0.1 fixed this.

### pyproject.toml not being included into setuptools

Turns out there's actually more work on the build backend than just expose their API as described in PEP-517. The
backend also needs to ensure that `pyproject.toml` is attached to the built source package, otherwise the build backend
on the user machine will not be able to use it. [setuptools 1650](https://github.com/pypa/setuptools/pull/1650) will fix
this for setuptools, on earlier versions one can just include `pyproject.toml` by specifying it inside `MANIFEST.in`.

{{/*< figure src="https://images.unsplash.com/photo-1524111890967-20e856be04d2?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ" caption="Photo by <a href="https://unsplash.com/@jorgezapatag?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Jorge Zapata</a> / <a href="https://unsplash.com/?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Unsplash</a> - what?! never though of that caseƒ" >*/}}

### Importing the built package from within `setup.py`

Another unexpected issue was when a package importing from within `setup.py`. The version of the package by convention
is exposed both as metadata for the package (in case of setuptools inside the `setup.py` as the `version` argument to
the `setup` function), but also under the `__version__` variable at the root of the package. One could specify the
content of the variable in both places, but then it becomes troublesome to keep it in sync.

As a workaround, many packages started putting it inside a `version.py` at the root of the package, and then import it
as `from mypy.version import __version__ as version` from both the `setup.py` and the package root. This worked because
when someone calls a python script the current working directory is automatically attached to the `sys.path` (so you can
import stuff exposed underneath it).

This behavior of adding the current working directory though was never mandated, it was more of a side-effect as
calling the build via `python setup.py sdist`. As this behavior is a side-effect (not a guarantee) all projects that
import from their `setup.py` should explicitly add the scripts folder to the sys path, at the start of the build.

It's up for debate if importing the built package during the packaging (when it's not yet built/distributed) is a good
idea or not (though the Python Packaging group is leaning towards it's not). Nevertheless, the fact of the matter is
that when `setuptools` exposed its interface via the `setuptools.build_meta` it choose not to add the current working
directory to the system path. The

PEP never mandates for the frontend to do this addition, as most build backend (declarative in nature) will never need
this. So such functionality was deemed to be under the responsibility of the front end. `setuptools` respectively thinks
if users want this functionality they should be explicit in their `setup.py` and add prepend manually the respective
path to the `sys.path`.

To simplify the pip code base pip decided to opt in into PEP-517 all people having a `pyproject.toml` into the
`setuptools` backend. Now with this issue even packages that haven't opted in to PEP-517 started to break. To fix this,
`setuptools` added a new build backend (`setuptools.build_meta:__legacy__`) designed to be used by frontends as a
default when the build backend is left unspecified; when projects add the `build-backend` key, they will have to also
change their `setup.py` to either add the source root to their `sys.path` or avoid importing from the source root.

### self bootstrapping backends

Another interesting problem was raised that has a much tighter user base, but exposes an interesting problem. In case we
don't want to use wheels, and we provision only via source distribution; how should we resolve the problem of how do we
provide the build backend's build backend? For example, `setuptools` packages itself via `setuptools`. So were
`setuptools` specify this via PEP-517 the build frontend would be put inside an infinite loop.

To install the library `pugs` it would first try to create an isolated environment. This environment needs `setuptools`,
so the build frontend will need to build a wheel to satisfy it. The wheel build would itself trigger the creation of an
isolated environment, which has build dependency again `setuptools`.

How to break this loop? Mandate all build backends must be exposed as wheels? Allow backends that can build themselves?
Should these self build backend allowed to take on dependencies? There's a long discussion with various options, pros
and cons, so if you're interested make sure to head over the
[python Discourse board](https://discuss.python.org/t/pep-517-backend-bootstrapping) and give your opinion.

{{/*< figure src="https://images.unsplash.com/photo-1499938971550-7ad287075e0d?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ" caption="Photo by <a href="https://unsplash.com/@sneakyelbow?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Sneaky Elbow</a> / <a href="https://unsplash.com/?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Unsplash</a> - we're all together in this" >*/}}

## Conclusion

Packaging is hard. Improving a packaging system without any breakage where users can write and run arbitrary code during
the packaging in your free time is probably impossible. With PEP-518 though now build dependencies are explicit and
build environments easy to create. With PEP-517 we can start moving into a more declarative packaging namespace, that
allows less space for users to make mistakes and provide better messages when things inevitably go wrong.Granted as we
go through this changes some packages might break, and we might disallow some practices that worked until now. We (PyPa
maintainers) don't do it in bad faith though, so when errors do pop up please do fill in a detailed error report with
what went wrong, how you tried to use it, and what is your use case.

We're trying to genuinely improve the packaging ecosystem, as such we've created the
`[integration-test](https://github.com/pypa/integration-test)` repository, as an effort to ensure that in future we can
catch at least some of these edge cases before they land on your machine. If you have any suggestion or requirements to
any part of packaging feel free to start a discussion on the
[Discuss Python forums](https://discuss.python.org/c/packaging) packaging section, or open an issue for the relevant
tool at hand.

{{/*< figure src="https://images.unsplash.com/photo-1517306896387-1b417036430b?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ" caption="Photo by <a href="https://unsplash.com/@itsmiki5?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Milan Popovic</a> / <a href="https://unsplash.com/?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Unsplash</a> - the end" >*/}}

That's all for now, thanks for reading through it all! I would like to thank
[Paul Ganssle](https://twitter.com/pganssle) for reviewing the packaging series post, and
[Tech At Bloomberg](https://twitter.com/techatbloomberg) for allowing me to do open source contributions during my
working hours.
