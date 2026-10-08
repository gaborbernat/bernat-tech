(function() {
  const toc = document.querySelector('.toc-content');
  if (!toc) return;

  const details = toc.querySelector('.toc-details');
  const narrow = window.matchMedia('(max-width: 900px)');
  const fold = function() {
    details.open = !narrow.matches;
  };
  fold();
  narrow.addEventListener('change', fold);

  const headings = document.querySelectorAll('.post-content h2[id], .post-content h3[id], .post-content h4[id], .post-content h5[id], .post-content h6[id]');
  if (!headings.length) return;

  const links = new Map();
  toc.querySelectorAll('a[href^="#"]').forEach(function(a) {
    links.set(a.getAttribute('href').slice(1), a);
  });

  function getVisibleSections() {
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + window.innerHeight;
    const visibleIds = [];
    let topmostId = null;
    let topmostDistance = Infinity;

    headings.forEach(function(heading) {
      const headingTop = heading.offsetTop;
      const headingBottom = headingTop + heading.offsetHeight;

      if (headingBottom >= viewportTop && headingTop <= viewportBottom) {
        visibleIds.push(heading.id);

        const distanceFromTop = Math.abs(headingTop - viewportTop);
        if (distanceFromTop < topmostDistance) {
          topmostDistance = distanceFromTop;
          topmostId = heading.id;
        }
      }
    });

    return { visible: visibleIds, topmost: topmostId };
  }

  function updateActiveToc() {
    const { visible, topmost } = getVisibleSections();

    links.forEach(function(link, id) {
      link.classList.toggle('toc-visible', visible.includes(id));
      link.classList.toggle('toc-active', id === topmost);
    });
  }

  let ticking = false;
  window.addEventListener('scroll', function() {
    if (!ticking) {
      window.requestAnimationFrame(function() {
        updateActiveToc();
        ticking = false;
      });
      ticking = true;
    }
  });

  updateActiveToc();
})();
