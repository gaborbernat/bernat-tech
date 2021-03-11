+++
author = "Bernat Gabor"
title = "Version numbers: how to use them?"
description = ""
tags = ["python", "version", "semver", "calver", "0ver"]
draft = false
slug = "version-numbers"
date = 2020-05-16T14:15:00Z
+++

The [DRY principle](https://en.wikipedia.org/wiki/Don%27t_repeat_yourself) (an acronym for don't repeat yourself)
encourages software engineers to abstract code into a separate component and reuse it rather than write it over and over
again. If this happens across the system, the best practice is to put it inside a package that lives on its own (a
library) and then pull it in from the applications when required.

As most of us can't think of every feature that the library might offer, or what bugs it might contain, these packages
tend to evolve. Therefore, we need some mechanism to encode these evolutions of the library, and most commonly, this is
a version number.

Version numbers and their meaning will come up both as a producer or as a consumer of libraries:

* as a producer of libraries, you'll have to decide what versioning system to use,
* as a consumer, you'll have to express with what versions of a given library your application/library is compatible.

What is a great version number, you might ask? If you do a quick search around, you'll find there are
[multiple schools of thought here](https://en.wikipedia.org/wiki/Software_versioning):

* [semantic versioning](https://semver.org/) (of which [ZeroVer](https://0ver.org/) is an ever-popular subset)
* [calendar versioning](https://calver.org/).

For those who read my articles, you'll know I like to sprinkle my otherwise technically dry posts with some lovely and
cute animal photos to give you at least some moments of relief while you're going through it. In this one, I'll use
pictures from my Yorkshire Terrier puppy, Silky. Without further ado (#ToT!!!)

{{< figure src="silky_tot.png" width="700px">}}

## Semantic and ZeroVer

So, which should you use? Historically, the go-to answer has been semantic versioning. This is defined as a three-number
string (separated with a period) in the format of `MAJOR.MINOR.PATCH`. Usually, it starts with `0.1.0`. Then depending
on the type of change you make to the library, you increment one of these and set subsequent numbers to zero:

* `MAJOR` version if you make backward-incompatible changes,
* `MINOR` version if you add a new feature,
* `PATCH` version if you fix bugs.

Version two of semantic versioning introduced additional labels to indicate pre-releases and build metadata; these are
appended after a hyphen at the end, for example `1.0.0-beta+exp.sha.5114f8`. For the point of this blog post, these are
not important. ZeroVer (a joke versioning system - released on April 1st) is similar to this with the sole difference
that `MAJOR` is always `0` and incompatible changes may be introduced at any point. Intended to make fun of people who
use "semantic versioning" but never make a `1.0` release, thus defeating the purpose of semver.

The version number in this context is used as a contract between the library developer and the systems pulling it in
about how freely they can upgrade. For example, if you wrote your web server against
[Django 3](https://pypi.org/project/Django/#history), you should be good to go with all Django 3 releases that are at
least as new as your current one. This allows you to express your Django dependency in the format of
`Django >= 3.0.2, <4`.

By using this format whenever you rebuild your application, you'll automatically pull in any new feature/bugfix/security
releases of `Django`, enabling you to use the latest and best version that is still guaranteed to work with your
project. This is great because:

* you enable automatic, compatibile security fixes,
* it automatically pulls in bug fixes on the library side,
* your application will keep building and working in the future as it did today because the significant version pin
  protects you from pulling in versions whose API would not match.

Does this uphold in practice? For me, [Hynek Schlawack](https://hynek.me/) pointed out first that it does not.
Initially, in some [tweets](https://twitter.com/llanga/status/1253962015846121472), and then in more detail within a
talk held at a [Remote Python Pizza](https://remote.python.pizza/) conference. Looking back at my experience with this,
I tend to agree.

{{< figure src="silky_sit.png" >}}

## What's the problem with semantic versioning?

On paper, semantic versioning seems to be addressing all we need to encode the evolution and state of our library. I
think the issue is not with the semantic versioning standard itself; indeed, people would like to follow it. However,
**most library maintainers/developers out there don't have enough resources to follow semantic versioning**.

Maintaining a library is very time-consuming. I can attest to that, as I have maintained two myself for a few years now:
tox (3) and virtualenv (2). My experience is within the Python ecosystem, but I can imagine other languages are similar.
Most libraries have just a few active maintainers available, for example:

* tox has 2,
* virtualenv 1,
* pytest around 4,
* pip around 4,
* python-dateutil 1.

And these are very high profile libraries. To make things even worse, some of their maintainers overlap (i.e. the same
person is the maintainer of multiple projects). And to complicate matters even further, for most maintainers this is not
a full-time job, but something on the side, part of their free time.

Given the scarce human resources to maintain a library, in practice there's a single supported version for any library
at any given point in time: **the latest one**. Any version before that (be that major, minor, patch) is in essence
abandoned:

* if you want security updates you need to move to the latest version,
* if you wish to a bugfix you need to move to the newest version,
* if you want a new feature, it is only going to be available in the latest version.

You get the idea. Unless you're thrilled with your current version, to pull in any change you will need to move to the
last released version (be that security improvement, bugfix or feature). Otherwise, you'll not get it.

{{< figure src="silky_wind.png" width="700px">}}

### Will a major version bump always break you?

At this point, you might think, "OK, so I need to pin down to the major version". As in, you need to specify the
dependency in the form of `tox>=3, <4`. However, semantic versioning is very strict about changing the API. Any
backward-incompatible change (no matter how small it is) must be followed with a major number bump.

A major version bump **must** happen not only when you rewrite an entire library with its complete API, but also when
you're just renaming a single rarely used function (which some may erroneously view as a minor change). Or even worse,
it's not always clear what's part of the public API and what's not.

You have a library with some incidental, undocumented and unspecified behavior that you consider to be obviously not
part of the public interface. You change it to solve what seems like a bug to you, and make a patch release, only to
find that you have angry hordes at the gate who, thanks to [Hyrum's Law](https://www.hyrumslaw.com/), depend on the old
behavior.

{{< figure src="https://imgs.xkcd.com/comics/workflow.png">}}

While every maintainer would like to believe they've thought of every use case up-front and created the best API for
everything, in practice, hindsight is our best teacher. As we run into more use cases, issues, and users, we get smarter
and work out what would be a better interface for that library, and what confuses the users the most.

Therefore there will be a lot of moments when, as a maintainer, you would like to change something. Doing a major bump
change every time will make your project quickly reach double-digit major versions, at which point users tend to
consider your project too unstable to be trusted. Often these major number changes only affect a low percentage of your
users (usually those using that one feature you changed in an incompatible fashion).

With a major version pinning the majority of other users are effectively opting out of bug fixes and security updates
(which should be critical), to defend against a change that in practice will rarely impact them. Sure, they can move on
to the next version by pinning again via something like `tox>=4, <5`. However, this involves manual intervention on
their code, and you might not have the time to do this for every one of your projects.

In my experience, this happens a lot. A lot more at least than when a major version bump breaks you. And then there's
another aspect version pinning will introduce: version conflicts.

{{< figure src="silky_tot_2.png" width="700px">}}

### Version conflicts

An application or library will have a set of libraries it depends on directly. These are libraries you're directly
importing within the application/library you're maintaining, but then the libraries themselves may rely on other
libraries. This is known as transitive dependency. Very soon, you'll get to a point where two different components use
the same library, and both of them might express version constraints on it.

For example consider the case of [tenacity](https://pypi.org/project/tenacity/#history): a general-purpose retrying
library. Imagine you were using this in your application, and being a religious follower of semantic versioning, you've
pinned it to the version that was out when you created the app in early 2018: 4.11. The constraint would specify version
4.11 or later, but less than the next major version 5.

At the same time you also connect to a HTTP service. This connection is handled by another library, and the maintainer
of that decided to also use tenacity to offer automatic retry functionality. They pinned it similarly following the
semantic versioning convention. Back in 2018, this caused no issues. But then August comes, and version 5.0 is released.

The service and its library maintainers have a lot more time on their hands (perhaps because they are paid to do so), so
they quickly move to version 5.0. Or perhaps they want to use a feature from the new major version. Now they introduce
the pin greater than five but less than six on tenacity. Their public interface does not change at all at this point, so
they do not bump their major version. It's just a patch release.

Python can only have one version of a library installed at a given time. At this point, there is a version conflict.
You're requesting a version between four and five, while the service library is requesting a version between five and
six. Both constraints cannot be satisfied.

If you use a version of [pip](https://pypi.org/project/pip) older than 20.2 ­— the release in which it added a
dependency resolver — it will just install a version matching the first constraint it finds and ignore any subsequent
constraints. Versions of pip _after_ 20.2 would fail with an error indicating that the constraint cannot be satisfied.

Either way, your application no longer works. The only way to make it work is to either pin the service library down to
the last working patch number, or upgrade your version pinning of tenacity. This is generating extra work for you with
minimal benefit. Often it might not be even possible to use two conflicting libraries until one of them relaxes their
requirements.

And for those who might think this doesn't happen often, let me say that tenacity released another major version a year
later in November 2019. Thus, the cycle starts all over again. In both cases, your code most likely did not need to
change at all, as just a small part of their public API changed.

A mildly complex application will easily have close to (or possibly more than) 100 dependencies, so such issues in my
experience start to appear every few months. You need only 5-6 of such cases for every 100 libraries for this issue to
pop up every two months on your plate. And potentially for a multiple of your applications.

{{< figure src="silky_yes.png" width="700px">}}

## Calendar Versioning

[CalVer](https://en.wikipedia.org/wiki/Software_versioning#Date_of_release), which was
[codified by Mahmoud Hashemi](https://sedimental.org/designing_a_version.html#calendar_versioning), suggests version
number to be in format of: `YEAR.MONTH.sequence`. For example, `20.1` indicates a release in 2020 January, while
`20.5.2` indicates a release that occurred in 2020 May, while the 2 indicates this is the third release of the month.

You can see it looks similar to semantic versioning and has the benefit that a later release qualifies as bigger than an
earlier one within the semantic versioning world (which mandates that a version number must grow monotonically). This
makes it easy to use in all places where semantic versioning can be used.

The idea here is that if the only maintained version is the latest, then we might as well use the version number to
indicate the release date to signify just how old of a version you're using. You also have the added benefit that you
can make calendar-based promises. For example, Ubuntu offers five years of support, therefore given version `20.04` you
can quickly determine that it will be supported up to April 2025.

{{< figure src="silky_jump.png" width="700px">}}

## A better way to handle API evolution?

Semantic versioning uses the major version to defend against breaking changes, and at the same offers maintainers the
freedom to evolve the library without breaking users. Nevertheless, as we could see above in practice, this does not
seem to work that well, as it causes you not to pull in bug fixes/security updates while also introducing version
conflicts. Do we have a better tool at hand for this?

Hynek suggests instead clear, time-window based deprecation policies, and as an optional sprinkle on top, warning
messages when using deprecated content. When you want to change a public-facing API: release the change under a new
interface, and in parallel, start emitting warning messages whenever someone invokes the old one. Maintain this state
for a migration period of a year, and communicate explicitly in the warning message the timeline for when users have to
migrate (calculate this by adding one year to your release date).

This gives everyone a year to move to the new interface without breaking their system, and then the library may remove
the change and get rid of the old design chains forever. As an added benefit, only people using the old interface will
ever see the warning, as opposed to affecting everyone (as seen with the semantic versioning major version bump).

One caveat for this to work is that one should stop upper-pinning dependencies. You should only specify the minimum
version you need to pull in newer versions freely if they exist. Lessons learned from version conflicts, though, might
already prompt you to do so. A major version breaks you a lot less often in practice than semantic versioning leads you
to believe.

Donald Stufft has also taken on this subject in a blog post titled
[Versioning Software](https://caremad.io/posts/2016/02/versioning-software/). I encourage you to read that too. Besides
the above points, he argues that by using semantic versioning, you're able to communicate to the end-user the intended
impact of a new release.

A patch version bump indicates no significant change is expected, and users should be able to upgrade quickly. A minor
or major version bump shows that the upgrade might introduce significant changes, and that users should set aside a
considerable amount of time when bumping such dependencies.

I operate slightly differently in the sense that I don't diff releases. Instead, I tend to **upgrade without version
constraints**. If the CI fails, I don't merge it; rather I investigate the failure when I have free time on my hands.
Lessons from the trenches suggest that **the only way to ensure an upgrade of any magnitude does not break you is to
have a comprehensive test suite.** Ideally, your test framework can collect and report whenever and where your code is
calling deprecated functions ([for example pytest](https://docs.pytest.org/en/latest/warnings.html#warnings-capture)).

{{< figure src="silky_wise.png" >}}

## Summary

Is semantic versioning irrevocably broken? Should it never be used? I don't think so. It still makes a lot of sense
where there are ample resources to maintain multiple versions in parallel. A great example of this is Django. However,
it feels less practical for projects that have just a few maintainers.

In this case, it often leads to opting people out of bug fixes and security updates. It also encourages version
conflicts in environments that can't have multiple versions of the same library, as is the case with Python.
Furthermore, it makes it a lot harder for developers to learn from their mistakes and evolve the API to a better place.
Rotten old design decisions will pull down the library for years to come.

A better solution at hand can be using CalVer and a time-window based warning system to evolve the API and remove old
interfaces. Does it solve all problems? Absolutely not.

One thing it makes harder is library rewrites. For example, consider
[virtualenv'](https://pypi.org/project/virtualenv/20.0.20/#history)s recent rewrite. Version 20 introduced a completely
new API and changed some behaviours to new defaults. For such use cases in a CalVer world, you would likely need to
release the rewritten project under a new name, such as virtualenv2. Then again, such complete rewrites are extremely
rare (in the case of virtualenv, it involved twelve years passing).

No version scheme will allow you to predict with any certainty how compatible your software will be with potential
future versions of your dependencies. The only reasonable choices are for libraries to choose minimum versions/excluded
versions only, never maximum versions. For applications, do the same thing, but also add in a lock file of known, good
versions with exact pins (this is the fundamental difference between
[install_requires and requirements.txt](https://packaging.python.org/discussions/install-requires-vs-requirements/)).

If you got this far you might want to also check the reasoning of
[Brett Cannon - Why I don't like SemVer anymore](https://snarky.ca/why-i-dont-like-semver/).

I want to thank [Anthony Sottile](https://twitter.com/codewithanthony), [Paul Ganssle](https://twitter.com/pganssle),
[Hynek Schlawack](https://twitter.com/hynek), and [Lisa McCord](https://twitter.com/LisaMcString) for reviewing this
article in its draft versions and suggesting changes that made it a thousand times better.

{{< figure src="silky_run_happy.png" width="700px">}}
