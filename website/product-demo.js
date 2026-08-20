const agentImage = (provider) =>
  provider === "claude" ? "assets/agents/claude.png" : "assets/agents/codex-white.png";

const agentAvatar = (provider, label) => `
  <span class="mx-agent-avatar mx-agent-${provider}">
    <img src="${agentImage(provider)}" alt="" />
    <span class="sr-only">${label}</span>
  </span>
`;

const sidebarRow = ({ icon, title, meta = "", selected = false, status = "" }) => `
  <div class="mx-sidebar-row${selected ? " is-selected" : ""}">
    <span class="mx-sidebar-icon" aria-hidden="true">${icon}</span>
    <span class="mx-sidebar-label">${title}</span>
    ${status ? `<span class="mx-row-status ${status}" aria-hidden="true"></span>` : ""}
    ${meta ? `<span class="mx-sidebar-meta">${meta}</span>` : ""}
  </div>
`;

const sidebar = (state) => {
  const taskSelected = state === "attention";
  return `
    <aside class="mx-sidebar" aria-hidden="true">
      <div class="mx-project-switcher">
        <span>Aurora Storefront</span><span class="mx-chevron">⌄</span>
      </div>
      <nav class="mx-sidebar-nav">
        ${sidebarRow({ icon: "＋", title: "New Task" })}
        ${sidebarRow({ icon: "⊞", title: "All Agents", selected: state === "agents" })}
        ${sidebarRow({ icon: "⑂", title: "Combine", meta: "2 ready", selected: state === "combine" })}
      </nav>
      <div class="mx-sidebar-groups">
        <div class="mx-sidebar-group">
          <span class="mx-overline">Running</span>
          ${sidebarRow({ icon: "", title: "Checkout redesign", status: "working", selected: taskSelected })}
        </div>
        <div class="mx-sidebar-group">
          <span class="mx-overline">Ready</span>
          ${sidebarRow({ icon: "", title: "Fix flaky tests", status: "ready" })}
          ${sidebarRow({ icon: "", title: "Search filters", status: "ready" })}
        </div>
      </div>
      <div class="mx-sidebar-footer">
        <span class="mx-live-dots"><i></i><i></i></span>
        <span>2 working</span><span class="mx-gear">⌘</span>
      </div>
    </aside>
  `;
};

const surfaceHeader = (title, subtitle, trailing = "") => `
  <header class="mx-surface-header">
    <div>
      <strong>${title}</strong>
      ${subtitle ? `<span>${subtitle}</span>` : ""}
    </div>
    ${trailing}
  </header>
`;

const agentCard = ({ provider, name, state, detail, ready = false, files }) => `
  <article class="mx-agent-card">
    <div class="mx-agent-card-head">
      ${agentAvatar(provider, name)}
      <div><strong>${name}</strong><span>${state}</span></div>
      <span class="mx-live-pill ${ready ? "ready" : ""}">${ready ? "Ready" : "Working"}</span>
    </div>
    <p>${detail}</p>
    <footer><span>${files} files changed</span><span>${ready ? "Checks passed" : "Native Terminal"}</span></footer>
  </article>
`;

const agentsSurface = () => `
  ${surfaceHeader("All Agents", "3 tasks across 2 coding agents", '<span class="mx-header-action">New Task</span>')}
  <div class="mx-surface-scroll mx-agents-view">
    <div class="mx-view-intro"><div><span class="mx-overline">In progress</span><strong>Work happening now</strong></div><span>Updated just now</span></div>
    <div class="mx-agent-grid">
      ${agentCard({
        provider: "claude",
        name: "Claude Code",
        state: "Working on Checkout redesign",
        detail: "Building the new checkout layout and connecting the delivery form.",
        files: 8,
      })}
      ${agentCard({
        provider: "codex",
        name: "Codex",
        state: "Fix flaky tests",
        detail: "Stabilized the cart suite and verified the full test run.",
        ready: true,
        files: 4,
      })}
    </div>
    <div class="mx-activity-strip"><span class="mx-ready-dot"></span><strong>Search filters</strong><span>Ready to combine</span><b>6 files</b></div>
  </div>
`;

const newTaskModal = () => `
  <div class="mx-modal-scrim" aria-hidden="true"></div>
  <section class="mx-task-modal">
    <header><div><strong>New task</strong><span>Write a brief, then work in the agent's full Terminal interface.</span></div><span>×</span></header>
    <div class="mx-task-modal-body">
      <div class="mx-prompt-field">Add a size and colour filter to product search, and keep the chosen filters in the URL.<span>↑</span></div>
      <span class="mx-overline">Agent</span>
      <div class="mx-agent-option is-selected">${agentAvatar("claude", "Claude Code")}<div><strong>Claude Code</strong><span>Best for multi-file changes</span></div><b>✓</b></div>
      <div class="mx-agent-option">${agentAvatar("codex", "Codex")}<div><strong>Codex</strong><span>Best for tests and fixes</span></div></div>
      <div class="mx-advanced">› Advanced</div>
    </div>
    <footer><span>Muxtra monitors the isolated result.</span><div><b>Cancel</b><strong>Create & Open Agent</strong></div></footer>
  </section>
`;

const startSurface = () => `${agentsSurface()}${newTaskModal()}`;

const combineTask = (provider, title, files) => `
  <div class="mx-combine-task is-selected">
    <span class="mx-checkbox">✓</span>${agentAvatar(provider, provider)}
    <div><strong>${title}</strong><span>${provider === "claude" ? "Claude Code" : "Codex"} · All checks passed</span></div>
    <b>${files} files</b>
  </div>
`;

const combineSurface = () => `
  ${surfaceHeader("Combine", "Bring finished work back together safely")}
  <div class="mx-surface-scroll mx-combine-view">
    <div class="mx-view-intro"><div><span class="mx-overline">Ready</span><strong>Select work to combine</strong></div><span>2 selected</span></div>
    <div class="mx-combine-list">
      ${combineTask("claude", "Checkout redesign", 8)}
      ${combineTask("codex", "Fix flaky tests", 4)}
    </div>
    <div class="mx-combine-summary">
      <div><span class="mx-merge-mark">⑂</span><div><strong>One verified result</strong><span>Muxtra checks the combined work before your project moves.</span></div></div>
      <ul><li><span>✓</span> Workspaces isolated</li><li><span>✓</span> No overlapping files</li><li><span>✓</span> Project checks configured</li></ul>
      <button type="button" tabindex="-1">Combine 2 Tasks</button>
    </div>
  </div>
`;

const attentionSurface = () => `
  ${surfaceHeader("Checkout redesign", "Claude Code · Working in Terminal", '<span class="mx-header-action">Show Terminal</span>')}
  <div class="mx-surface-scroll mx-attention-view mx-mission-view">
    <div class="mx-mission-overview">
      <span class="mx-mission-status"></span>
      <div><strong>Working</strong><small>Building the new checkout layout and connecting the delivery form.</small></div>
      <b>8 files</b>
    </div>
    <div class="mx-conflict-banner"><span>!</span><div><strong>Another task is changing the same files</strong><small>Search filters overlaps in 2 paths. Both agents remain isolated.</small></div><b>Review</b></div>
    <div class="mx-mission-grid">
      <article><header><strong>Isolated workspace</strong><span>Open</span></header><code>…/workspaces/checkout-redesign</code><small>Changes stay separate until you combine them.</small></article>
      <article><header><strong>Project checks</strong></header><div class="mx-check-state"><i>◷</i><span><b>Checks come next</b><small>Muxtra verifies the finished version.</small></span></div></article>
    </div>
    <div class="mx-file-list">
      <header><div><strong>Changed files</strong><small>Muxtra watches the workspace, not the conversation.</small></div><span>Review Changes</span></header>
      <code>src/routes/checkout/CheckoutPage.tsx</code>
      <code>src/components/DeliveryMethod.tsx</code>
      <code>src/styles/checkout.css</code>
    </div>
  </div>
`;

const surfaceFor = (state) => {
  if (state === "start") return startSurface();
  if (state === "combine") return combineSurface();
  if (state === "attention") return attentionSurface();
  return agentsSurface();
};

class MuxtraAppDemo extends HTMLElement {
  static observedAttributes = ["state"];

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const state = this.getAttribute("state") || "agents";
    this.innerHTML = `
      <div class="mx-app-window mx-state-${state}">
        <div class="mx-traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div>
        ${sidebar(state)}
        <main class="mx-main-surface">${surfaceFor(state)}</main>
      </div>
    `;
  }
}

if (!customElements.get("muxtra-app-demo")) {
  customElements.define("muxtra-app-demo", MuxtraAppDemo);
}
