const API_URL = '/api/data';

const state = {
  view: 'home', // home | dashboard | entry
  data: [],
  search: '',
  filter: 'All',
  sort: 'updated_at',
  selectedId: null,
  showModal: false,
  modalMode: 'new',
  toast: '',
  form: {
    id: '',
    title: '',
    status: 'To Do',
    priority: 'Medium',
    due_date: '',
    note: ''
  }
};

const statusClass = {
  'To Do': 'bg-slate-100 text-slate-700 ring-1 ring-slate-200',
  'Doing': 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  'Done': 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  'Blocked': 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
};

const priorityClass = {
  High: 'text-rose-600',
  Medium: 'text-amber-600',
  Low: 'text-emerald-600'
};

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDateInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 10);
}

async function loadData() {
  const res = await fetch(API_URL);
  const json = await res.json();
  state.data = json.data || [];
  if (!state.selectedId && state.data.length) state.selectedId = state.data[0].id;
  render();
}

async function saveData(tasks) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', tasks })
  });
  return res.json();
}

function filteredTasks() {
  return (state.data || [])
    .filter((t) => state.filter === 'All' ? true : t.status === state.filter)
    .filter((t) => `${t.title} ${t.note} ${t.priority} ${t.status}`.toLowerCase().includes(state.search.toLowerCase()))
    .sort((a, b) => String(b[state.sort] || '').localeCompare(String(a[state.sort] || '')));
}

function renderHome() {
  return `
    <div class="space-y-8">
      <section class="rounded-[2rem] border border-slate-200 bg-white p-8 shadow-sm shadow-slate-200/60">
        <div class="max-w-3xl">
          <div class="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-sm text-blue-700 ring-1 ring-blue-100">Simontok Workspace</div>
          <h1 class="mt-4 text-4xl font-bold tracking-tight text-slate-900">Team Task Management</h1>
          <p class="mt-3 text-slate-600 text-lg">Pilih masuk ke dashboard monitoring atau langsung ke halaman entri. Data tersimpan di Google Spreadsheet via Apps Script.</p>
        </div>
        <div class="mt-8 grid gap-4 sm:grid-cols-2 max-w-2xl">
          <button id="goDashboard" class="rounded-3xl border border-slate-200 bg-slate-900 px-6 py-5 text-left text-white shadow-sm hover:bg-slate-800 transition">
            <div class="text-xs uppercase tracking-[0.2em] text-slate-300">Dashboard</div>
            <div class="mt-2 text-xl font-semibold">Masuk ke Dashboard Monitoring</div>
            <div class="mt-1 text-sm text-slate-300">Lihat progres, status, dan ringkasan task.</div>
          </button>
          <button id="goEntry" class="rounded-3xl border border-slate-200 bg-white px-6 py-5 text-left text-slate-900 shadow-sm hover:bg-slate-50 transition">
            <div class="text-xs uppercase tracking-[0.2em] text-slate-500">Entri</div>
            <div class="mt-2 text-xl font-semibold">Masuk ke Entri</div>
            <div class="mt-1 text-sm text-slate-500">Tambah, edit, dan hapus task ke Spreadsheet.</div>
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderModal() {
  if (!state.showModal) return '';
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div class="w-full max-w-2xl rounded-3xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
        <div class="p-5 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-slate-500">${state.modalMode === 'new' ? 'New Task' : 'Edit Task'}</div>
            <h3 class="text-xl font-semibold text-slate-900">${state.modalMode === 'new' ? 'Buat Tugas Baru' : 'Ubah Tugas'}</h3>
          </div>
          <button id="closeModal" class="rounded-full px-3 py-2 text-slate-600 hover:bg-slate-100">✕</button>
        </div>
        <form id="taskForm" class="p-5 grid gap-4 md:grid-cols-2">
          <input type="hidden" name="id" value="${escapeHtml(state.form.id)}" />
          <div class="md:col-span-2">
            <label class="text-sm text-slate-700">Task</label>
            <input name="title" value="${escapeHtml(state.form.title)}" class="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Contoh: Kirim surat pemeriksaan" required />
          </div>
          <div>
            <label class="text-sm text-slate-700">Status</label>
            <select name="status" class="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500">
              ${['To Do','Doing','Done','Blocked'].map(s => `<option ${state.form.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="text-sm text-slate-700">Priority</label>
            <select name="priority" class="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500">
              ${['High','Medium','Low'].map(s => `<option ${state.form.priority === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="text-sm text-slate-700">Due date</label>
            <input name="due_date" type="date" value="${escapeHtml(formatDateInput(state.form.due_date))}" class="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label class="text-sm text-slate-700">Updated</label>
            <input name="updated_at" type="date" value="${escapeHtml(formatDateInput(state.form.updated_at || new Date().toISOString().slice(0,10)))}" class="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="md:col-span-2">
            <label class="text-sm text-slate-700">Note</label>
            <textarea name="note" rows="4" class="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Catatan singkat..."></textarea>
          </div>
          <div class="md:col-span-2 flex items-center justify-end gap-3 pt-2">
            <button type="button" id="cancelModal" class="rounded-2xl border border-slate-200 px-4 py-3 text-slate-700 hover:bg-slate-100">Batal</button>
            <button class="rounded-2xl bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-500">Simpan</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderTaskCard(task) {
  return `
    <button data-open="${task.id}" class="w-full text-left rounded-3xl border border-slate-200 bg-white hover:bg-slate-50 transition p-4 shadow-sm">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-semibold text-slate-900 truncate">${escapeHtml(task.title || 'Untitled')}</div>
          <div class="mt-1 text-sm text-slate-500 line-clamp-2">${escapeHtml(task.note || 'Tidak ada catatan')}</div>
        </div>
        <span class="shrink-0 rounded-full px-2.5 py-1 text-[11px] ${statusClass[task.status] || statusClass['To Do']}">${escapeHtml(task.status)}</span>
      </div>
      <div class="mt-4 flex items-center justify-between text-xs">
        <span class="${priorityClass[task.priority] || 'text-slate-600'}">${escapeHtml(task.priority)}</span>
        <span class="text-slate-500">${escapeHtml(task.due_date || '-')}</span>
      </div>
    </button>
  `;
}

function renderDetail(task) {
  if (!task) return `<div class="rounded-3xl border border-slate-200 bg-white p-6 text-slate-500 shadow-sm">Pilih task untuk melihat detail.</div>`;
  return `
    <div class="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-xs uppercase tracking-[0.2em] text-slate-500">Task detail</div>
          <h2 class="mt-1 text-2xl font-bold text-slate-900">${escapeHtml(task.title)}</h2>
        </div>
        <span class="rounded-full px-3 py-1.5 text-xs ${statusClass[task.status] || statusClass['To Do']}">${escapeHtml(task.status)}</span>
      </div>
      <div class="mt-5 grid grid-cols-2 gap-3 text-sm">
        <div class="rounded-2xl bg-slate-50 p-3"><div class="text-slate-500 text-xs">Priority</div><div class="mt-1 font-medium ${priorityClass[task.priority] || 'text-slate-700'}">${escapeHtml(task.priority)}</div></div>
        <div class="rounded-2xl bg-slate-50 p-3"><div class="text-slate-500 text-xs">Due date</div><div class="mt-1 font-medium text-slate-700">${escapeHtml(task.due_date || '-')}</div></div>
        <div class="rounded-2xl bg-slate-50 p-3"><div class="text-slate-500 text-xs">Updated</div><div class="mt-1 font-medium text-slate-700">${escapeHtml(task.updated_at || '-')}</div></div>
        <div class="rounded-2xl bg-slate-50 p-3"><div class="text-slate-500 text-xs">Created</div><div class="mt-1 font-medium text-slate-700">${escapeHtml(task.created_at || '-')}</div></div>
      </div>
      <div class="mt-5">
        <div class="text-sm font-semibold mb-2 text-slate-800">Note</div>
        <div class="rounded-2xl bg-slate-50 p-4 text-sm text-slate-700 whitespace-pre-wrap">${escapeHtml(task.note || 'Tidak ada catatan')}</div>
      </div>
      <div class="mt-5 flex gap-3">
        <button data-edit="${task.id}" class="flex-1 rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-500">Edit</button>
        <button data-delete="${task.id}" class="rounded-2xl border border-slate-200 px-4 py-3 text-slate-700 hover:bg-slate-100">Hapus</button>
      </div>
    </div>
  `;
}

function renderDashboard() {
  const tasks = filteredTasks();
  const selected = tasks.find((t) => String(t.id) === String(state.selectedId)) || tasks[0] || null;
  const todo = tasks.filter(t => t.status === 'To Do');
  const doing = tasks.filter(t => t.status === 'Doing');
  const done = tasks.filter(t => t.status === 'Done');
  const blocked = tasks.filter(t => t.status === 'Blocked');
  const total = (state.data || []).length;

  return `
    <div class="flex flex-col lg:flex-row gap-6">
      <aside class="lg:w-72 shrink-0 rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="h-12 w-12 rounded-2xl bg-blue-50 grid place-items-center text-blue-700 font-bold">S</div>
          <div>
            <div class="font-semibold text-slate-900">Simontok</div>
            <div class="text-sm text-slate-500">Team task dashboard</div>
          </div>
        </div>
        <div class="mt-6 grid grid-cols-2 gap-3">
          <button id="newTaskBtn" class="rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-500">+ New Task</button>
        </div>
        <div class="mt-6 space-y-3 text-sm">
          <button data-filter="All" class="filterBtn w-full rounded-2xl px-4 py-3 text-left ${state.filter === 'All' ? 'bg-slate-100' : 'bg-transparent hover:bg-slate-50'}">All <span class="float-right text-slate-500">${total}</span></button>
          <button data-filter="To Do" class="filterBtn w-full rounded-2xl px-4 py-3 text-left ${state.filter === 'To Do' ? 'bg-slate-100' : 'bg-transparent hover:bg-slate-50'}">To Do <span class="float-right text-slate-500">${todo.length}</span></button>
          <button data-filter="Doing" class="filterBtn w-full rounded-2xl px-4 py-3 text-left ${state.filter === 'Doing' ? 'bg-slate-100' : 'bg-transparent hover:bg-slate-50'}">Doing <span class="float-right text-slate-500">${doing.length}</span></button>
          <button data-filter="Done" class="filterBtn w-full rounded-2xl px-4 py-3 text-left ${state.filter === 'Done' ? 'bg-slate-100' : 'bg-transparent hover:bg-slate-50'}">Done <span class="float-right text-slate-500">${done.length}</span></button>
          <button data-filter="Blocked" class="filterBtn w-full rounded-2xl px-4 py-3 text-left ${state.filter === 'Blocked' ? 'bg-slate-100' : 'bg-transparent hover:bg-slate-50'}">Blocked <span class="float-right text-slate-500">${blocked.length}</span></button>
        </div>
      </aside>

      <main class="flex-1 min-w-0 space-y-6">
        <section class="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm">
          <div class="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
            <div>
              <div class="text-xs uppercase tracking-[0.25em] text-slate-500">Overview</div>
              <h1 class="mt-1 text-3xl font-bold text-slate-900">To‑Do Dashboard</h1>
              <p class="mt-1 text-slate-500">Sederhana, cepat, dan enak dipakai.</p>
            </div>
            <div class="flex flex-col md:flex-row gap-3">
              <input id="searchBox" value="${escapeHtml(state.search)}" placeholder="Cari task..." class="w-full md:w-80 rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500" />
              <select id="sortBox" class="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500">
                <option value="updated_at" ${state.sort === 'updated_at' ? 'selected' : ''}>Latest updated</option>
                <option value="due_date" ${state.sort === 'due_date' ? 'selected' : ''}>Due date</option>
                <option value="title" ${state.sort === 'title' ? 'selected' : ''}>Task name</option>
              </select>
            </div>
          </div>
          <div class="mt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
            <div class="rounded-3xl bg-slate-50 p-4 border border-slate-200"><div class="text-slate-500 text-sm">Total</div><div class="mt-2 text-3xl font-bold text-slate-900">${total}</div></div>
            <div class="rounded-3xl bg-slate-50 p-4 border border-slate-200"><div class="text-slate-500 text-sm">To Do</div><div class="mt-2 text-3xl font-bold text-slate-900">${todo.length}</div></div>
            <div class="rounded-3xl bg-slate-50 p-4 border border-slate-200"><div class="text-slate-500 text-sm">Doing</div><div class="mt-2 text-3xl font-bold text-slate-900">${doing.length}</div></div>
            <div class="rounded-3xl bg-slate-50 p-4 border border-slate-200"><div class="text-slate-500 text-sm">Done</div><div class="mt-2 text-3xl font-bold text-slate-900">${done.length}</div></div>
          </div>
        </section>

        <section class="rounded-[2rem] border border-slate-200 bg-white p-4 overflow-hidden shadow-sm">
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="text-slate-500 border-b border-slate-200">
                <tr><th class="py-3 px-3">Task</th><th class="py-3 px-3">Status</th><th class="py-3 px-3">Priority</th><th class="py-3 px-3">Due</th><th class="py-3 px-3">Updated</th></tr>
              </thead>
              <tbody>
                ${tasks.map((t) => `
                  <tr data-open="${t.id}" class="border-b border-slate-100 hover:bg-slate-50 cursor-pointer">
                    <td class="py-4 px-3 font-medium text-slate-900">${escapeHtml(t.title)}</td>
                    <td class="py-4 px-3"><span class="rounded-full px-2.5 py-1 text-xs ${statusClass[t.status] || statusClass['To Do']}">${escapeHtml(t.status)}</span></td>
                    <td class="py-4 px-3 ${priorityClass[t.priority] || 'text-slate-600'}">${escapeHtml(t.priority)}</td>
                    <td class="py-4 px-3 text-slate-700">${escapeHtml(t.due_date || '-')}</td>
                    <td class="py-4 px-3 text-slate-700">${escapeHtml(t.updated_at || '-')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <aside class="xl:w-[360px] shrink-0 space-y-4">
        ${renderDetail(selected)}
        ${state.toast ? `<div class="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700">${escapeHtml(state.toast)}</div>` : ''}
      </aside>
    </div>
  `;
}

function renderEntry() {
  const tasks = filteredTasks();
  const selected = tasks.find((t) => String(t.id) === String(state.selectedId)) || tasks[0] || null;

  return `
    <div class="grid gap-6 xl:grid-cols-[1fr_360px]">
      <section class="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-slate-500">Entri</div>
            <h2 class="text-2xl font-bold text-slate-900">Kelola Data Task</h2>
          </div>
          <button id="newTaskBtn" class="rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-500">+ New Task</button>
        </div>

        <div class="mt-5 flex flex-col md:flex-row gap-3">
          <input id="searchBox" value="${escapeHtml(state.search)}" placeholder="Cari task..." class="w-full md:w-80 rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500" />
          <select id="sortBox" class="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500">
            <option value="updated_at" ${state.sort === 'updated_at' ? 'selected' : ''}>Latest updated</option>
            <option value="due_date" ${state.sort === 'due_date' ? 'selected' : ''}>Due date</option>
            <option value="title" ${state.sort === 'title' ? 'selected' : ''}>Task name</option>
          </select>
        </div>

        <div class="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr><th class="py-3 px-3">Task</th><th class="py-3 px-3">Status</th><th class="py-3 px-3">Priority</th><th class="py-3 px-3">Due</th><th class="py-3 px-3">Updated</th></tr>
            </thead>
            <tbody>
              ${tasks.map((t) => `
                <tr data-open="${t.id}" class="border-b border-slate-100 hover:bg-slate-50 cursor-pointer">
                  <td class="py-4 px-3 font-medium text-slate-900">${escapeHtml(t.title)}</td>
                  <td class="py-4 px-3"><span class="rounded-full px-2.5 py-1 text-xs ${statusClass[t.status] || statusClass['To Do']}">${escapeHtml(t.status)}</span></td>
                  <td class="py-4 px-3 ${priorityClass[t.priority] || 'text-slate-600'}">${escapeHtml(t.priority)}</td>
                  <td class="py-4 px-3 text-slate-700">${escapeHtml(t.due_date || '-')}</td>
                  <td class="py-4 px-3 text-slate-700">${escapeHtml(t.updated_at || '-')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>

      <aside class="space-y-4">
        ${renderDetail(selected)}
        ${state.toast ? `<div class="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700">${escapeHtml(state.toast)}</div>` : ''}
      </aside>
    </div>
  `;
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  if (state.view === 'home') {
    app.innerHTML = `<div class="max-w-7xl mx-auto px-4 py-6">${renderHome()}</div>`;
  } else if (state.view === 'dashboard') {
    app.innerHTML = `<div class="max-w-7xl mx-auto px-4 py-6">${renderDashboard()}</div>${renderModal()}`;
  } else {
    app.innerHTML = `<div class="max-w-7xl mx-auto px-4 py-6">${renderEntry()}</div>${renderModal()}`;
  }

  document.getElementById('goDashboard')?.addEventListener('click', () => { state.view = 'dashboard'; render(); });
  document.getElementById('goEntry')?.addEventListener('click', () => { state.view = 'entry'; render(); });

  document.getElementById('searchBox')?.addEventListener('input', (e) => { state.search = e.target.value; render(); });
  document.getElementById('sortBox')?.addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  document.getElementById('newTaskBtn')?.addEventListener('click', () => openModal('new'));

  document.querySelectorAll('.filterBtn').forEach((btn) => {
    btn.addEventListener('click', () => { state.filter = btn.getAttribute('data-filter'); render(); });
  });

  document.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => { state.selectedId = el.getAttribute('data-open'); render(); });
  });

  document.querySelectorAll('[data-edit]').forEach((el) => {
    el.addEventListener('click', () => {
      const task = state.data.find((t) => String(t.id) === String(el.getAttribute('data-edit')));
      openModal('edit', task);
    });
  });

  document.querySelectorAll('[data-delete]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.getAttribute('data-delete');
      state.data = state.data.filter((t) => String(t.id) !== String(id));
      await saveData(state.data);
      state.toast = 'Task dihapus';
      await loadData();
    });
  });

  document.getElementById('closeModal')?.addEventListener('click', () => { state.showModal = false; render(); });
  document.getElementById('cancelModal')?.addEventListener('click', () => { state.showModal = false; render(); });

  document.getElementById('taskForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const row = Object.fromEntries(form.entries());
    row.title = row.title?.trim();
    row.note = row.note?.trim();
    row.updated_at = row.updated_at || new Date().toISOString().slice(0, 10);
    row.created_at = state.modalMode === 'new'
      ? row.updated_at
      : (state.data.find((t) => String(t.id) === String(row.id))?.created_at || row.updated_at);

    if (state.modalMode === 'new') {
      row.id = String(Date.now());
      state.data.unshift(row);
      state.toast = 'Task tersimpan';
    } else {
      const idx = state.data.findIndex((t) => String(t.id) === String(row.id));
      if (idx >= 0) state.data[idx] = { ...state.data[idx], ...row };
      state.toast = 'Task diperbarui';
    }

    await saveData(state.data);
    state.showModal = false;
    await loadData();
  });
}

function openModal(mode, task = null) {
  state.modalMode = mode;
  state.showModal = true;
  state.form = task
    ? { ...task, due_date: formatDateInput(task.due_date), updated_at: formatDateInput(task.updated_at) }
    : { id: '', title: '', status: 'To Do', priority: 'Medium', due_date: '', note: '', updated_at: new Date().toISOString().slice(0, 10) };
  render();
}

window.addEventListener('DOMContentLoaded', loadData);
