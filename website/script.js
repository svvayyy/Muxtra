const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");

const setHeaderState = () => {
  header?.classList.toggle("is-scrolled", window.scrollY > 16);
};

setHeaderState();
window.addEventListener("scroll", setHeaderState, { passive: true });

navToggle?.addEventListener("click", () => {
  const isOpen = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!isOpen));
  nav?.classList.toggle("is-open", !isOpen);
});

nav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    navToggle?.setAttribute("aria-expanded", "false");
    nav?.classList.remove("is-open");
  });
});

const revealItems = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px" },
  );

  revealItems.forEach((item) => revealObserver.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

const showcaseDemo = document.querySelector("#showcase-demo");
const showcaseTabs = [...document.querySelectorAll("[data-demo-state]")];

showcaseTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.getAttribute("aria-selected") === "true" || !showcaseDemo) return;

    showcaseTabs.forEach((candidate) => {
      candidate.setAttribute("aria-selected", String(candidate === tab));
    });

    showcaseDemo.classList.add("is-changing");
    window.setTimeout(() => {
      showcaseDemo.setAttribute("state", tab.dataset.demoState);
      showcaseDemo.setAttribute("aria-label", tab.dataset.alt || "Muxtra product view");
      requestAnimationFrame(() => showcaseDemo.classList.remove("is-changing"));
    }, 110);
  });
});

document.querySelector("[data-copy-command]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const command = 'muxtra start "Fix the checkout" --agent codex';

  try {
    await navigator.clipboard.writeText(command);
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 1600);
  } catch {
    button.textContent = command;
  }
});

document.querySelectorAll("[data-year]").forEach((element) => {
  element.textContent = String(new Date().getFullYear());
});
