// Progressive enhancement for the server-rendered pages. Everything works without it except the
// mod filter buttons, the all/none type buttons, live sync progress, the score link check, and the
// replay panel's select-all box and confirmation prompts.

const STATES = ["off", "required", "optional", "excluded"];
const FIELDS = { required: "mods", optional: "mods_optional", excluded: "mods_excluded" };

function setupModFilter(fieldset) {
  const form = fieldset.closest("form");
  const inputs = Object.fromEntries(Object.entries(FIELDS).map(([state, name]) => [state, fieldset.querySelector(`input[name="${name}"]`)]));
  const buttons = () => fieldset.querySelectorAll("[data-mod]");

  function write() {
    const lists = { required: new Set(), optional: new Set(), excluded: new Set() };
    for (const button of buttons()) if (button.dataset.state !== "off") lists[button.dataset.state].add(button.dataset.mod);
    for (const [state, input] of Object.entries(inputs)) input.value = [...lists[state]].join(",");
  }

  fieldset.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mod]");
    if (!button) return;
    const next = STATES[(STATES.indexOf(button.dataset.state) + 1) % STATES.length];
    // The same mod can appear in the common row and in its category; keep both in step.
    for (const twin of fieldset.querySelectorAll(`[data-mod="${button.dataset.mod}"]`)) twin.dataset.state = next;
    const nomod = form.querySelector('input[name="nomod"]');
    if (nomod && next !== "off") nomod.checked = false;
    write();
  });

  const search = fieldset.querySelector("[data-modsearch]");
  search?.addEventListener("input", () => {
    const term = search.value.trim().toLowerCase();
    for (const button of fieldset.querySelectorAll("[data-allmods] [data-mod]")) {
      button.hidden = term !== "" && !`${button.dataset.mod} ${button.title}`.toLowerCase().includes(term);
    }
  });
}

function setupFilterForm(form) {
  // Leave empty fields out of the URL so links stay short and shareable.
  form.addEventListener("submit", () => {
    for (const element of form.elements) {
      if ((element.tagName === "INPUT" || element.tagName === "SELECT") && element.name && element.value === "") element.disabled = true;
    }
  });
}

function setupCheckAll(fieldset) {
  fieldset.querySelector("[data-checkall-buttons]").hidden = false;
  fieldset.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-checkall]");
    if (!button) return;
    for (const box of fieldset.querySelectorAll('input[type="checkbox"]')) box.checked = button.dataset.checkall === "true";
  });
}

function setupSyncPolling(slot) {
  const read = () => {
    const status = slot.querySelector("[data-sync-status]");
    return status ? `${status.dataset.lastSuccess}|${status.dataset.active}` : "";
  };
  const initial = read();
  const poll = async () => {
    try {
      const response = await fetch("/partials/sync", { headers: { Accept: "text/html" } });
      if (!response.ok) return;
      slot.innerHTML = await response.text();
      const typing = document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
      // A job started or finished: reload so stats, buttons and results match.
      if (read() !== initial && !typing) location.reload();
    } catch {
      // Offline or restarting; try again on the next tick.
    }
  };
  setInterval(poll, 5000);
}

function setupScoreLink(box) {
  const button = box.querySelector("[data-scorelink-check]");
  const error = box.querySelector("[data-scorelink-error]");
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Checking…";
    error.hidden = true;
    try {
      const response = await fetch(`/api/scores/${box.dataset.score}/link`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to check the score.");
      box.querySelector("[data-scorelink-url]")?.remove();
      if (data.url) {
        const link = Object.assign(document.createElement("a"), { href: data.url, target: "_blank", rel: "noopener noreferrer", textContent: "View score on osu! ↗" });
        link.dataset.scorelinkUrl = "";
        box.prepend(link);
        button.textContent = "Recheck link";
      } else {
        error.textContent = "This score is no longer on osu!. The saved copy is kept.";
        error.hidden = false;
        button.textContent = "Check online score";
      }
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      button.textContent = "Check online score";
    } finally {
      button.disabled = false;
    }
  });
}

function setupReplayManager(form) {
  const boxes = () => [...form.querySelectorAll('input[name="id"]')];
  const selectAll = form.querySelector("[data-select-all]");
  const count = form.querySelector("[data-selected-count]");
  const update = () => {
    const checked = boxes().filter((box) => box.checked).length;
    count.textContent = checked ? `${checked} selected` : "Tick replays to act on them.";
    for (const button of form.querySelectorAll("[data-needs-selection]")) button.disabled = checked === 0;
    selectAll.checked = checked > 0 && checked === boxes().length;
    selectAll.indeterminate = checked > 0 && checked < boxes().length;
  };
  selectAll.hidden = false;
  selectAll.addEventListener("change", () => {
    for (const box of boxes()) box.checked = selectAll.checked;
    update();
  });
  form.addEventListener("change", (event) => {
    if (event.target.name === "id") update();
  });
  update();
}

// Destructive forms and buttons carry data-confirm; "{n}" is how many replays are ticked.
function confirmSubmit(event) {
  const form = event.target;
  const message = event.submitter?.dataset.confirm ?? form.dataset.confirm;
  const ticked = form.querySelectorAll('input[name="id"]:checked').length;
  if (message && !confirm(message.replace("{n}", String(ticked)))) event.preventDefault();
}

document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("submit", confirmSubmit);
  document.querySelectorAll("[data-replay-manager]").forEach(setupReplayManager);
  document.querySelectorAll("[data-modfilter]").forEach(setupModFilter);
  document.querySelectorAll("[data-filters]").forEach(setupFilterForm);
  document.querySelectorAll("fieldset[data-checkall]").forEach(setupCheckAll);
  document.querySelectorAll("[data-sync-slot]").forEach(setupSyncPolling);
  document.querySelectorAll("[data-scorelink]").forEach(setupScoreLink);
});
