+++
author = "Bernat Gabor"
date = 2019-02-07T13:40:59Z
description = ""
draft = false
image = "https://images.unsplash.com/photo-1540553932586-115aeb2a84cd?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ"
slug = "pep-517-518"
tags = ["python", "pip", "install", "packaging", "setuptools", "pep517", "pep518"]
title = "Python packaging - Past, Present, Future"
+++

Have you ever wondered what happens exactly when you run pip install? This post will give you a detailed overview of the
steps involved in the past, and how it all changes with the adoption of PEP-517 and PEP-518.

[In my previous post](https://www.bernat.tech/pep-517-and-python-packaging/) I've described how it's possible to install
three types of content: source tree, source distribution and wheels. Only the last two types are uploaded to PyPi the
central Python repository, however one could get its hands on a source tree too (by feeding for example a git protocol
for pip). The advantage of wheels over the others is that it does not require any build operation to happen on the user
machine; it's just download and extract.

## Building python packages

Now independent where the build happens (user or the developer machine), you still need to build the package (either the
sdist or wheel). To do this, you need some builder in place. Historically, the need for third-party packages manifested
itself early on. Following the principle that Python has batteries included in the year 2000 with Python 1.6, the
[distutils](https://packaging.python.org/key_projects/#distutils) package was added to the Python standard library. It
introduced the concept of the `setup.py` file containing the build logic, and is triggered via `python setup.py cmd`.

It allowed users to package code as libraries, but did not have features such as declaration and automatic installation
of dependencies. Furthermore, its improvement lifecycle was directly tied to the core interpreter release cycle. In 2004
`setuptools` was created, which built on top of `distutils` and extended it with other nice features.. It quickly became
very popular to the point that most python installation started to provide it together with the core interpreter itself.

Back in those days, all packages were source distributions. Wheel distributions came along a lot later, in 2014.
_distutils_ was created back when only a few highly proficient people did packaging. As such it is very flexible and
imperative, you write a python script, you can modify every step in the package generation process.

The downside of this though is that it's anything but easy to learn and understand. This started to become more and more
an issue as Python grew in popularity and we had more and more users who were less proficient in the inner workings of
Python.

{{/_< figure
src="https://images.unsplash.com/photo-1541364983171-a8ba01e95cfc?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ"
caption="Photo by
<a href="https://unsplash.com/@charlesdeluvio?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Charles
🇵🇭</a> /
<a href="https://unsplash.com/?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Unsplash</a> -
ehhh" >_/}}

### build requirements

For installing a source distribution pip mostly **did** the following:

1. discover the package
2. download the source distribution and extract it
3. run `python setup.py install` on the extracted folder (does a build + install).

Developers did `python setup.py sdist` to generate the distribution, and `python setup.py upload` to upload it to a
central repository (the upload command has been deprecated with 2013 in favour of the
[twine](https://pypi.org/project/twine/) tool most notably due to the upload using non-secure HTTP connection, and
upload command also did a fresh build, not allowing the end user to inspect the generated package before the actual
upload).

When pip ran the `python setup.py install`, it did so with the python interpreter for which it was installing the
package. As such the build operation had access to all third-party packages already available inside that interpreter.
Most notably, it used exactly the _setuptools_ version that was installed on the host python interpreter. If a package
used a _setuptools_ feature available on a newer release than currently installed the only way one could complete the
installation was to update first the installed _setuptools._

This potentially can cause problems if a new release contained a bug that broke other packages. It is especially
troublesome on systems where the users can't alter installed packages. Then there was also the problem of what happens
when the builder (e.g. setuptools) want to use other helper packages, such as cython.

If any of these helpers was missing the build usually just broke with a failed to import package error:

```
      File "setup_build.py", line 99, in run
        from Cython.Build import cythonize
    ImportError: No module named Cython.Build
```

There was no way to provision such build dependencies from the developers' side. It also meant that users needed to
install all packaging build dependencies even if they did not want to use that at runtime. To solve this issue
[PEP-518](https://www.python.org/dev/peps/pep-0518/) was created.

The idea is that instead of using the host python with its currently installed packages for build, the package provides
the ability to be explicit about what they need for their build operation. Also instead of making this available on the
host python, we create an isolated python (think of a sort of virtual environment) to run the packaging with.

`python setup.py install` now becomes:

1. create a temporary folder
2. create an isolated (from the third-party site packages) python environment `python -m virtualenv our_build_env`,
   let's refer to this python executable as `python_isolated`
3. install the build dependencies
4. generate a wheel we can install via `python_isolated setup.py bdist_wheel`
5. extract wheel to site packages of `python`.

With this we can install packages that depend on `cython` without actually installing `cython` inside the runtime python
environment. The file and method of specifying the build dependencies is the `pyproject.toml` metadata file:

```toml
[build-system]
requires = ["setuptools >= 40.8.0", "wheel >= 0.30.0", "cython >= 0.29.4"]
```

Furthermore, this also allows for whoever does the packaging to be explicit about what minimum versions they require for
the packaging, and these can be easily provisioned via pip transparently on the user machines.

The same mechanism can also be used when generating the source distribution or the wheel on the developers' machine.
When one invokes the `pip wheel . --no-deps` command that will automatically create in the background an isolated python
that satisfies the build systems dependencies, and then call inside that environment the `python setup.py bdist_wheel`
or `python setup.py sdist` command.

{{/_< figure
src="https://images.unsplash.com/photo-1512723185835-0700e5069a9a?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ"
caption="Photo by
<a href="https://unsplash.com/@star2dev?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Bruce
Galpin</a> /
<a href="https://unsplash.com/?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Unsplash</a> -
yay!" >_/}}

### packaging tool diversity

Now there's one more problem here though. Note all these operations still go through the mechanism introduced twenty
years ago, aka executing `setup.py`. The whole ecosystem still builds on the top of the _distutils_ and _setuptools_
interface that cannot change much due to trying to preserving backwards compatibility.

Also, executing arbitrary user side Python code during packaging though it is dangerous which can lead to subtle errors
hard to debug by less experienced users. Imperative build systems were great for flexibility twenty years ago when we
were not aware yet of all the use cases, but now that we have a good understanding we probably can make very robust and
easy package builders for various use cases.

To quote [Paul Ganssle](https://twitter.com/pganssle) (maintainer of `setuptools`and `dateutil` on this):

> Ideally the default option would be a declarative build configuration that works well for the 99% case, with an option
> to fall back to an imperative system when you really need the flexibility. At this point, it's feasible for us to move
> to a world where it's considered a code smell if you find you need to reach for the imperative build options.

> The biggest problem with `setup.py` is that most people use it declaratively, and when they use it imperatively, they
> tend to introduce bugs into the build system. One example of this: if you have a Python 2.7-only dependency you may be
> tempted to specify it conditionally with `sys.version` in your `setup.py`, but `sys.version` only refers to the
> interpreter that _executed_ the build; instead, you should be using the declarative environment markers for your
> install requirements..

[flit](https://pypi.org/project/flit/) proved this assumption correct already with its introduction in 2015. It has
become the favourite packaging tool for many newcomers to Python, as makes sure new users avoid a lot of these footguns.
However, to get to this point _flit_ had to again build on top of _distutils_/_setuptools,_ which makes its
implementation non-trivial, and the code base quite a few shim layers (it still generates the `setup.py` file for
example for its source distributions).

It's time to free it from these shackles, and also encourage other people to build their own packaging tools that make
packaging easy for their use cases, time to make `setup.py` the exception rather than the default.
[`setuptools` plans to offer a `setup.cfg`](https://github.com/pypa/setuptools/pull/1675) only user interface to lead
the way, and when a PEP-517 system is in place you should prefer that over using the `setup.py` for most cases. To not
tie everything back to `setuptools` and `distutils` and facilitate creation of new build backends
[PEP-517](https://www.python.org/dev/peps/pep-0517/) was created. It separates builders into a backend and fronted. The
frontend provides an isolated python environment satisfying all the declared build dependencies; the backend provides
hooks that the frontend can call from its isolated environment to generate either a source distribution or wheel.

Furthermore, instead of talking with the backend via the `setup.py` file and its commands, we move to python modules and
functions. All packaging backends must provide a python object API that implements two methods
`[build_wheel](https://www.python.org/dev/peps/pep-0517/#build-wheel)` and
`[build_sdist](https://www.python.org/dev/peps/pep-0517/#id9)` at the minimum. The API object point is specified via the
`pyproject.toml` file under the `build-backend` key:

```toml
[build-system]
requires = ["flit"]
build-backend = "flit.api:main"
```

The above code effectively means for the frontend that you can get hold of the backend by running the above code inside
the isolated python environment:

```python
import flit.api
backend = flit.api.main

# build wheel via
backend.build_wheel()

# build source distribution via
backend.build_sdist()
```

It's up to the backend where and how they want to expose their official API:

1. [flit](https://flit.readthedocs.io/en/latest/) does it via `flit.buildapi`
2. [setuptools](https://setuptools.readthedocs.io/en/latest/history.html#v40-8-0) provides two variants:
   `setuptools.build_meta` (on why read on later)
3. [poetry](https://poetry.eustace.io/docs/pyproject/#poetry-and-pep-517) does it via `poetry.masonry.api`

With this we can start having packaging tools that are no longer bound to the legacy decisions of the `distutils` in the
frontend.

{{/_< figure
src="https://images.unsplash.com/photo-1536298191882-3b2dd65a853b?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ"
caption="Photo by
<a href="https://unsplash.com/@dubeysarthak?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Sarthak
Dubey</a> /
<a href="https://unsplash.com/?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Unsplash</a> - more
yay!" >_/}}

# tox and packaging

[tox is testing tool](https://tox.readthedocs.io/en/latest/) and used by most projects to ensure compatibility against
multiple Python interpreter version of a given package. It also allows easily creating python environments that have the
package under inspection installed in it, making reproducing failures faster.

To be able to test a package it first needs to build a source distribution though. While both PEP-518 and PEP-517 should
make things better, turning them on can break packaging under some use cases. Therefore when
[`tox`](https://tox.readthedocs.io/en/latest/) added isolated build in version
[`3.3.0`](https://tox.readthedocs.io/en/latest/) decided to not enable it by default, for now. You need to manually
enable it (will probably be turned on by default in version `4` sometime later this year - 2019).

Once you've specified a `pyproject.toml` with appropriate `requires` and `build-backend` you need to turn on the
`isolated_build` flag inside `tox.ini`:

```ini
[tox]
isolated_build = True
```

After this, tox in its [packaging phase](https://tox.readthedocs.io/en/latest/#system-overview) will build the source
distribution by providing the build dependencies into an isolated python environment per PEP-518, and will call the
build backend as stated in PEP-517. Otherwise, tox will use the old way of building source distributions, that is
invoking the `python setup.py sdist` command with the same interpreter tox is installed into.

{{/_< figure
src="https://images.unsplash.com/photo-1423958950820-4f2f1f44e075?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max&ixid=eyJhcHBfaWQiOjExNzczfQ"
caption="Photo by
<a href="https://unsplash.com/@matthewhenry?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Matthew
Henry</a> /
<a href="https://unsplash.com/?utm_source=ghost&amp;utm_medium=referral&amp;utm_campaign=api-credit">Unsplash</a> - no
free lunch here, yet!" >_/}}

## Conclusion

The Python Packaging Authority hopes that all this makes sense and will allow to have a more user friendly, error proof
and stable builds. The specifications for these standards were written up and debated in long threads between 2015
and 2017. The proposals were deemed good enough to benefit the most, but some less mainstream use cases could have been
overlooked.

If your use case is such, don't worry the PEPs are open of enhancement at any point if we deem required.
[In my next post of this series here](https://www.bernat.tech/growing-pain/) I'll go over some of the pain points the
community bumped into while releasing these two PEPs. These should serve as lessons learned, and will show that there's
still some work to be done. It's not everything perfect yet, however we're getting better. Join the packaging community
if you can help out, and let's make things better together!
