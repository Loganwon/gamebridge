// Progressive enhancement only: the design document works without JavaScript.
const links = [...document.querySelectorAll('.toc nav a')];
const sections = links.map((link) => document.querySelector(link.getAttribute('href'))).filter(Boolean);

if ('IntersectionObserver' in window) {
  const visibleSections = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleSections.set(entry.target.id, entry.boundingClientRect.top);
      else visibleSections.delete(entry.target.id);
    }
    const activeId = sections.find((section) => visibleSections.has(section.id))?.id;
    if (!activeId) return;
    for (const link of links) {
      if (link.getAttribute('href') === `#${activeId}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }, { rootMargin: '-10% 0px -55% 0px', threshold: 0 });
  for (const section of sections) observer.observe(section);
}
