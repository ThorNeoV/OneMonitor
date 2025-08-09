// Injects a "OneDriveCheck" column into the device grid and adds a filter.
// Fetches live status via /plugin/onedrivecheck/status
(function(){
  // Utility: find device id for a row. Works across MC versions by trying a few attrs.
  function getRowDeviceId(row) {
    return row.getAttribute('deviceid') ||
           row.dataset.deviceid ||
           (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) ||
           row.getAttribute('nodeid') ||
           row.dataset.nodeid || null;
  }

  function addColumnHeader() {
    var grid = document.getElementById('devices');
    if (!grid) return false;
    var thead = grid.querySelector('thead');
    if (!thead) return false;
    var tr = thead.querySelector('tr');
    if (!tr) return false;

    if (!document.getElementById('col_onedrivecheck')) {
      var th = document.createElement('th');
      th.id = 'col_onedrivecheck';
      th.textContent = 'OneDriveCheck';
      tr.appendChild(th);
    }
    return true;
  }

  function ensureCells() {
    var grid = document.getElementById('devices');
    if (!grid) return [];
    var rows = grid.querySelectorAll('tbody tr');
    var ids = [];
    rows.forEach(function(row){
      if (!row.querySelector('.onedrivecheck-cell')) {
        var td = document.createElement('td');
        td.className = 'onedrivecheck-cell';
        td.textContent = '—';
        row.appendChild(td);
      }
      var id = getRowDeviceId(row);
      if (id) ids.push(id);
    });
    return ids;
  }

  function paintRows(statusMap) {
    var rows = document.querySelectorAll('#devices tbody tr');
    rows.forEach(function(row){
      var id = getRowDeviceId(row);
      var td = row.querySelector('.onedrivecheck-cell');
      if (!td) return;
      var s = (id && statusMap && statusMap[id]) ? statusMap[id] : null;
      if (!s) { td.textContent = '—'; td.dataset.state = ''; return; }

      td.textContent = s.status || '—';
      td.title = '20707:' + (s.port20707 ? 'open' : 'closed') + ', 20773:' + (s.port20773 ? 'open' : 'closed');
      td.dataset.state = (s.port20707 ? 'online' : (s.port20773 ? 'notsigned' : 'offline'));

      // optional styling hints
      // td.style.opacity = 1;
    });
  }

  function fetchStatus(ids) {
    if (!ids || ids.length === 0) return Promise.resolve({});
    var url = '/plugin/onedrivecheck/status?' + ids.map(function(id){ return 'id=' + encodeURIComponent(id); }).join('&');
    return fetch(url, { credentials: 'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
  }

  function applyFilter() {
    var sel = document.getElementById('filter_onedrivecheck');
    if (!sel) return;
    var mode = sel.value;
    var rows = document.querySelectorAll('#devices tbody tr');
    rows.forEach(function(r){
      var td = r.querySelector('.onedrivecheck-cell');
      var state = td ? td.dataset.state : '';
      var show = true;
      if (mode === 'offline')   show = (state === 'offline');
      if (mode === 'notsigned') show = (state === 'notsigned');
      if (mode === 'online')    show = (state === 'online');
      r.style.display = show ? '' : 'none';
    });
  }

  function addFilterUI() {
    var bar = document.getElementById('deviceToolbar') || document.querySelector('.DeviceToolbar') || document.querySelector('#Toolbar');
    if (!bar) return;
    if (document.getElementById('filter_onedrivecheck')) return;

    var label = document.createElement('span');
    label.style.marginLeft = '10px';
    label.textContent = 'OneDriveCheck: ';

    var sel = document.createElement('select');
    sel.id = 'filter_onedrivecheck';
    var opts = [
      {v:'all',      t:'All'},
      {v:'offline',  t:'App Offline (20707 closed & 20773 closed)'},
      {v:'notsigned',t:'Not signed in (20773 open)'},
      {v:'online',   t:'Online (20707 open)'}
    ];
    opts.forEach(function(o){
      var opt = document.createElement('option'); opt.value = o.v; opt.text = o.t; sel.appendChild(opt);
    });
    sel.onchange = applyFilter;

    bar.appendChild(label);
    bar.appendChild(sel);
  }

  function refreshNow() {
    if (!addColumnHeader()) return;
    addFilterUI();
    var ids = ensureCells();
    fetchStatus(ids).then(function(map){
      paintRows(map);
      applyFilter();
    });
  }

  // Run initially and whenever the device table refreshes.
  // Different MC builds fire different events; cover a few.
  document.addEventListener('meshcentralDeviceListRefreshEnd', refreshNow);
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(refreshNow, 500); });
  // Fallback: poll the DOM a bit after navigation
  setInterval(function(){
    var grid = document.getElementById('devices');
    if (grid && !document.getElementById('col_onedrivecheck')) refreshNow();
  }, 4000);
})();
