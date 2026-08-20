/*** CODE.GS — Apps Script backend (deploy as Web App) ***/

function getProp(k){ return PropertiesService.getScriptProperties().getProperty(k); }
function setProp(k,v){ PropertiesService.getScriptProperties().setProperty(k,v); }

function rootFolder(){
  var id = getProp('ROOT_FOLDER_ID');
  if (!id) throw new Error('ROOT_FOLDER_ID not set. Run setup() once.');
  return DriveApp.getFolderById(id);
}
function subFolder(name){
  var root = rootFolder();
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}
function dataFile(name, folder){
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}
function readJSON(file, fallback){
  if (!file) return fallback;
  try { return JSON.parse(file.getBlob().getDataAsString()); } catch(e){ return fallback; }
}
function writeJSON(name, folder, obj){
  var file = dataFile(name, folder);
  var content = JSON.stringify(obj);
  if (file) file.setContent(content);
  else folder.createFile(name, content, MimeType.PLAIN_TEXT);
}

function hash(pw, salt){
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw + '::' + salt);
  return digest.map(function(b){ return (b<0?b+256:b).toString(16).padStart(2,'0'); }).join('');
}
function newToken(){ return Utilities.getUuid() + Utilities.getUuid(); }

/* one-time setup: run manually from the Apps Script editor */
function setup(){
  var folder = DriveApp.createFolder('ICADD Records Storage'); // or use DriveApp.getFolderById('existing id')
  setProp('ROOT_FOLDER_ID', folder.getId());
}

function ensureFolders(){
  return {
    users: subFolder('Users'),
    inward: subFolder('Inward'),
    outward: subFolder('Outward'),
    attendance: subFolder('Attendance'),
    audit: subFolder('AuditLog'),
    attachments: subFolder('Attachments'),
    sessions: subFolder('Sessions'),
    folders: subFolder('Folders')
  };
}

function loadAll(){
  var f = ensureFolders();
  return {
    f: f,
    users: readJSON(dataFile('users.json', f.users), []),
    inward: readJSON(dataFile('inward.json', f.inward), []),
    outward: readJSON(dataFile('outward.json', f.outward), []),
    attendance: readJSON(dataFile('attendance.json', f.attendance), []),
    audit: readJSON(dataFile('audit.json', f.audit), []),
    sessions: readJSON(dataFile('sessions.json', f.sessions), {}),
    folders: readJSON(dataFile('folders.json', f.folders), [])
  };
}
function save(kind, f, data){ writeJSON(kind+'.json', f[kind]||f.folders, data); }

function logAudit(state, actorEmail, action, description, refNo){
  state.audit.unshift({
    id:'a_'+Date.now(), time:new Date().toISOString(), actor:actorEmail,
    action:action, description:description||'', refNo:refNo||''
  });
  writeJSON('audit.json', state.f.audit, state.audit);
}

function findUser(state, username){
  return state.users.filter(function(u){ return u.username===username; })[0] || null;
}
function findUserById(state, id){
  return state.users.filter(function(u){ return u.id===id; })[0] || null;
}
function sessionUser(state, token){
  var s = state.sessions[token];
  if (!s) return null;
  if (new Date(s.expires) < new Date()) return null;
  return findUserById(state, s.uid);
}
function requireAuth(state, token){
  var u = sessionUser(state, token);
  if (!u) throw new Error('AUTH_REQUIRED');
  if (u.accessStatus !== 'active') throw new Error('ACCOUNT_INACTIVE');
  return u;
}
function requireAdmin(state, token){
  var u = requireAuth(state, token);
  if (u.role !== 'admin') throw new Error('ADMIN_ONLY');
  return u;
}
function requirePerm(state, token, key){
  var u = requireAuth(state, token);
  if (u.role==='admin') return u;
  if (!u.permissions || !u.permissions[key]) throw new Error('PERMISSION_DENIED:'+key);
  return u;
}

var DEFAULT_PERMISSIONS = {
  dashboard_view:true,
  inward_view:false, inward_create:false, inward_edit:false,
  outward_view:false, outward_create:false, outward_edit:false,
  attendance_view:false, attendance_manage:false,
  storage_view:false, storage_download:false, storage_modify:false, storage_delete:false,
  reports_view:false
};

/* ================= ACTIONS ================= */
var ACTIONS = {

  bootstrap_admin: function(p, state){
    // only works if there are zero users yet
    if (state.users.length) throw new Error('ALREADY_INITIALISED');
    var salt = Utilities.getUuid();
    var u = {
      id:'u_'+Date.now(), username:p.username, name:p.name||p.username,
      email:p.email||'', role:'admin', accessStatus:'active',
      permissions: DEFAULT_PERMISSIONS, salt:salt, passHash:hash(p.password, salt),
      createdAt:new Date().toISOString()
    };
    state.users.push(u);
    save('users', state.f, state.users);
    logAudit(state, p.username, 'BOOTSTRAP_ADMIN_CREATED', 'Initial administrator created');
    return {ok:true};
  },

  login: function(p, state){
    var u = findUser(state, p.username);
    if (!u) throw new Error('INVALID_CREDENTIALS');
    if (hash(p.password, u.salt) !== u.passHash) throw new Error('INVALID_CREDENTIALS');
    if (u.accessStatus !== 'active') throw new Error('ACCOUNT_INACTIVE');
    var token = newToken();
    state.sessions[token] = {uid:u.id, expires:new Date(Date.now()+12*3600*1000).toISOString()};
    save('sessions', state.f, state.sessions);
    logAudit(state, u.username, 'LOGIN', '');
    var safe = JSON.parse(JSON.stringify(u)); delete safe.passHash; delete safe.salt;
    return {token:token, user:safe};
  },

  logout: function(p, state){
    delete state.sessions[p.token];
    save('sessions', state.f, state.sessions);
    return {ok:true};
  },

  who_am_i: function(p, state){
    var u = requireAuth(state, p.token);
    var safe = JSON.parse(JSON.stringify(u)); delete safe.passHash; delete safe.salt;
    return {user:safe};
  },

  /* ---- employees / users ---- */
  create_employee: function(p, state){
    var actor = requireAdmin(state, p.token);
    if (findUser(state, p.username)) throw new Error('USERNAME_TAKEN');
    var salt = Utilities.getUuid();
    var u = {
      id:'u_'+Date.now()+Math.floor(Math.random()*999), username:p.username, name:p.name,
      employeeCode:p.employeeCode||'', designation:p.designation||'', section:p.section||'',
      office:p.office||'', mobile:p.mobile||'', email:p.email||'', joiningDate:p.joiningDate||'',
      role:p.role||'field_officer', accessStatus:'active',
      permissions: p.permissions || DEFAULT_PERMISSIONS,
      salt:salt, passHash:hash(p.password, salt), createdAt:new Date().toISOString(), createdBy:actor.username
    };
    state.users.push(u);
    save('users', state.f, state.users);
    logAudit(state, actor.username, 'USER_CREATED', u.name+' ('+u.username+')');
    return {ok:true, id:u.id};
  },

  list_employees: function(p, state){
    requireAdmin(state, p.token);
    return {employees: state.users.map(function(u){ var s=JSON.parse(JSON.stringify(u)); delete s.passHash; delete s.salt; return s; })};
  },

  update_employee: function(p, state){
    var actor = requireAdmin(state, p.token);
    var u = findUserById(state, p.id);
    if (!u) throw new Error('NOT_FOUND');
    ['name','employeeCode','designation','section','office','mobile','email','joiningDate','role'].forEach(function(k){
      if (p[k]!==undefined) u[k]=p[k];
    });
    save('users', state.f, state.users);
    logAudit(state, actor.username, 'USER_UPDATED', u.name);
    return {ok:true};
  },

  set_access_status: function(p, state){
    var actor = requireAdmin(state, p.token);
    var u = findUserById(state, p.id);
    if (!u) throw new Error('NOT_FOUND');
    u.accessStatus = p.status;
    save('users', state.f, state.users);
    logAudit(state, actor.username, 'ACCESS_STATUS_CHANGED', u.name+' -> '+p.status);
    return {ok:true};
  },

  reset_password: function(p, state){
    var actor = requireAdmin(state, p.token);
    var u = findUserById(state, p.id);
    if (!u) throw new Error('NOT_FOUND');
    var salt = Utilities.getUuid();
    u.salt = salt; u.passHash = hash(p.newPassword, salt);
    save('users', state.f, state.users);
    logAudit(state, actor.username, 'PASSWORD_RESET', u.name);
    return {ok:true};
  },

  change_own_password: function(p, state){
    var u = requireAuth(state, p.token);
    if (hash(p.oldPassword, u.salt) !== u.passHash) throw new Error('WRONG_CURRENT_PASSWORD');
    var salt = Utilities.getUuid();
    u.salt = salt; u.passHash = hash(p.newPassword, salt);
    save('users', state.f, state.users);
    logAudit(state, u.username, 'PASSWORD_CHANGED_SELF', '');
    return {ok:true};
  },

  set_permissions: function(p, state){
    var actor = requireAdmin(state, p.token);
    var u = findUserById(state, p.id);
    if (!u) throw new Error('NOT_FOUND');
    u.permissions = p.permissions;
    save('users', state.f, state.users);
    logAudit(state, actor.username, 'PERMISSIONS_CHANGED', u.name);
    return {ok:true};
  },

  /* ---- inward / outward ---- */
  create_inward: function(p, state){
    var actor = requirePerm(state, p.token, 'inward_create');
    var rec = {
      id:'in_'+Date.now(), date:p.date, from:p.from, refNo:p.refNo, subject:p.subject,
      remarks:p.remarks||'', attachment:p.attachment||null, status:'Received',
      assignedTo:null, priority:'Normal', dueDate:null, actionHistory:[],
      enteredBy:actor.username, createdAt:new Date().toISOString()
    };
    state.inward.unshift(rec);
    save('inward', state.f, state.inward);
    logAudit(state, actor.username, 'INWARD_CREATED', p.subject, p.refNo);
    return {ok:true, id:rec.id};
  },

  list_inward: function(p, state){
    var u = requirePerm(state, p.token, 'inward_view');
    return {inward: state.inward};
  },

  create_outward: function(p, state){
    var actor = requirePerm(state, p.token, 'outward_create');
    var rec = {
      id:'out_'+Date.now(), date:p.date, to:p.to, refNo:p.refNo, subject:p.subject,
      remarks:p.remarks||'', attachment:p.attachment||null, linkedInwardId:p.linkedInwardId||null,
      enteredBy:actor.username, createdAt:new Date().toISOString()
    };
    state.outward.unshift(rec);
    save('outward', state.f, state.outward);
    if (p.linkedInwardId){
      var iw = state.inward.filter(function(x){return x.id===p.linkedInwardId;})[0];
      if (iw){ iw.status='Outward Issued'; save('inward', state.f, state.inward); }
    }
    logAudit(state, actor.username, 'OUTWARD_CREATED', p.subject, p.refNo);
    return {ok:true, id:rec.id};
  },

  bulk_upsert_inward: function(p, state){
    var actor = requirePerm(state, p.token, 'inward_create');
    var rows = p.rows || [];
    var replaceDuplicates = !!p.replaceDuplicates;
    var created = 0, updated = 0, skipped = [];
    rows.forEach(function(row, idx){
      if (!row.subject || !row.refNo){ skipped.push('Row '+(idx+2)+': missing Inward Number or Subject'); return; }
      var existing = state.inward.filter(function(x){ return String(x.refNo)===String(row.refNo); })[0];
      if (existing){
        if (replaceDuplicates){
          existing.date = row.date||existing.date;
          existing.from = row.from||existing.from;
          existing.subject = row.subject;
          existing.remarks = row.remarks||'';
          existing.actionHistory = existing.actionHistory || [];
          existing.actionHistory.push({action:'Replaced via upload', by:actor.username, at:new Date().toISOString()});
          updated++;
        } else {
          skipped.push('Inward Number '+row.refNo+' already exists — skipped (not replaced)');
        }
        return;
      }
      state.inward.unshift({
        id:'in_'+Date.now()+'_'+idx, date:row.date||'', from:row.from||'', refNo:row.refNo, subject:row.subject,
        remarks:row.remarks||'', attachment:null, status:'Received',
        assignedTo:null, priority:'Normal', dueDate:null, actionHistory:[],
        enteredBy:actor.username, createdAt:new Date().toISOString()
      });
      created++;
    });
    save('inward', state.f, state.inward);
    logAudit(state, actor.username, 'INWARD_BULK_UPSERT', created+' created, '+updated+' replaced'+(skipped.length? ', '+skipped.length+' skipped':''));
    return {ok:true, created:created, updated:updated, skipped:skipped};
  },

  bulk_upsert_outward: function(p, state){
    var actor = requirePerm(state, p.token, 'outward_create');
    var rows = p.rows || [];
    var replaceDuplicates = !!p.replaceDuplicates;
    var created = 0, updated = 0, skipped = [];
    rows.forEach(function(row, idx){
      if (!row.subject || !row.refNo){ skipped.push('Row '+(idx+2)+': missing Outward Number or Subject'); return; }
      var linkedId = null;
      if (row.linkedInwardNumber){
        var match = state.inward.filter(function(x){ return String(x.refNo)===String(row.linkedInwardNumber); })[0];
        if (match) linkedId = match.id;
        else skipped.push('Row '+(idx+2)+': linked Inward Number "'+row.linkedInwardNumber+'" not found (saved without link)');
      }
      var existing = state.outward.filter(function(x){ return String(x.refNo)===String(row.refNo); })[0];
      if (existing){
        if (replaceDuplicates){
          existing.date = row.date||existing.date;
          existing.to = row.to||existing.to;
          existing.subject = row.subject;
          existing.remarks = row.remarks||'';
          if (linkedId) existing.linkedInwardId = linkedId;
          updated++;
        } else {
          skipped.push('Outward Number '+row.refNo+' already exists — skipped (not replaced)');
        }
        return;
      }
      state.outward.unshift({
        id:'out_'+Date.now()+'_'+idx, date:row.date||'', to:row.to||'', refNo:row.refNo, subject:row.subject,
        remarks:row.remarks||'', attachment:null, linkedInwardId:linkedId,
        enteredBy:actor.username, createdAt:new Date().toISOString()
      });
      if (linkedId){
        var iw = state.inward.filter(function(x){return x.id===linkedId;})[0];
        if (iw) iw.status = 'Outward Issued';
      }
      created++;
    });
    save('outward', state.f, state.outward);
    save('inward', state.f, state.inward);
    logAudit(state, actor.username, 'OUTWARD_BULK_UPSERT', created+' created, '+updated+' replaced'+(skipped.length? ', '+skipped.length+' skipped':''));
    return {ok:true, created:created, updated:updated, skipped:skipped};
  },

  bulk_delete_inward: function(p, state){
    var actor = requireAdmin(state, p.token);
    var ids = p.ids || [];
    var removed = [];
    state.inward = state.inward.filter(function(x){
      if (ids.indexOf(x.id)!==-1){ removed.push(x.refNo); return false; }
      return true;
    });
    save('inward', state.f, state.inward);
    logAudit(state, actor.username, 'INWARD_BULK_DELETED', removed.length+' entries deleted: '+removed.join(', '));
    return {ok:true, deleted: removed.length};
  },

  bulk_delete_outward: function(p, state){
    var actor = requireAdmin(state, p.token);
    var ids = p.ids || [];
    var removed = [];
    state.outward = state.outward.filter(function(x){
      if (ids.indexOf(x.id)!==-1){ removed.push(x.refNo); return false; }
      return true;
    });
    save('outward', state.f, state.outward);
    logAudit(state, actor.username, 'OUTWARD_BULK_DELETED', removed.length+' entries deleted: '+removed.join(', '));
    return {ok:true, deleted: removed.length};
  },

  list_outward: function(p, state){
    requirePerm(state, p.token, 'outward_view');
    return {outward: state.outward};
  },

  update_inward: function(p, state){
    var actor = requirePerm(state, p.token, 'inward_edit');
    var rec = state.inward.filter(function(x){return x.id===p.id;})[0];
    if (!rec) throw new Error('NOT_FOUND');
    ['date','from','refNo','subject','remarks'].forEach(function(k){ if (p[k]!==undefined) rec[k]=p[k]; });
    if (p.attachment!==undefined) rec.attachment = p.attachment;
    rec.actionHistory = rec.actionHistory || [];
    rec.actionHistory.push({action:'Edited', by:actor.username, at:new Date().toISOString()});
    save('inward', state.f, state.inward);
    logAudit(state, actor.username, 'INWARD_EDITED', rec.subject, rec.refNo);
    return {ok:true};
  },

  delete_inward: function(p, state){
    var actor = requireAdmin(state, p.token);
    var idx = -1;
    for (var i=0;i<state.inward.length;i++){ if (state.inward[i].id===p.id){ idx=i; break; } }
    if (idx===-1) throw new Error('NOT_FOUND');
    var rec = state.inward[idx];
    state.inward.splice(idx,1);
    save('inward', state.f, state.inward);
    logAudit(state, actor.username, 'INWARD_DELETED', rec.subject, rec.refNo);
    return {ok:true};
  },

  update_outward: function(p, state){
    var actor = requirePerm(state, p.token, 'outward_edit');
    var rec = state.outward.filter(function(x){return x.id===p.id;})[0];
    if (!rec) throw new Error('NOT_FOUND');
    ['date','to','refNo','subject','remarks','linkedInwardId'].forEach(function(k){ if (p[k]!==undefined) rec[k]=p[k]; });
    if (p.attachment!==undefined) rec.attachment = p.attachment;
    save('outward', state.f, state.outward);
    logAudit(state, actor.username, 'OUTWARD_EDITED', rec.subject, rec.refNo);
    return {ok:true};
  },

  delete_outward: function(p, state){
    var actor = requireAdmin(state, p.token);
    var idx = -1;
    for (var i=0;i<state.outward.length;i++){ if (state.outward[i].id===p.id){ idx=i; break; } }
    if (idx===-1) throw new Error('NOT_FOUND');
    var rec = state.outward[idx];
    state.outward.splice(idx,1);
    save('outward', state.f, state.outward);
    logAudit(state, actor.username, 'OUTWARD_DELETED', rec.subject, rec.refNo);
    return {ok:true};
  },

  delete_file: function(p, state){
    var actor = requirePerm(state, p.token, 'storage_delete');
    var file = DriveApp.getFileById(p.fileId);
    var name = file.getName();
    file.setTrashed(true);
    logAudit(state, actor.username, 'FILE_DELETED', name);
    return {ok:true};
  },

  assign_entry: function(p, state){
    var actor = requireAdmin(state, p.token);
    var iw = state.inward.filter(function(x){return x.id===p.inwardId;})[0];
    if (!iw) throw new Error('NOT_FOUND');
    iw.assignedTo = p.assignedTo; iw.priority = p.priority||'Normal';
    iw.instructions = p.instructions||''; iw.dueDate = p.dueDate||null; iw.status='Assigned';
    iw.actionHistory.push({action:'Assigned to '+p.assignedTo, by:actor.username, at:new Date().toISOString()});
    save('inward', state.f, state.inward);
    logAudit(state, actor.username, 'ENTRY_ASSIGNED', iw.subject, iw.refNo);
    return {ok:true};
  },

  update_entry_status: function(p, state){
    var actor = requireAuth(state, p.token);
    var iw = state.inward.filter(function(x){return x.id===p.inwardId;})[0];
    if (!iw) throw new Error('NOT_FOUND');
    if (actor.role!=='admin' && iw.assignedTo!==actor.id && iw.assignedTo!==actor.username) throw new Error('NOT_ASSIGNED_TO_YOU');
    iw.status = p.status;
    iw.actionHistory.push({action:'Status: '+p.status, by:actor.username, at:new Date().toISOString()});
    save('inward', state.f, state.inward);
    logAudit(state, actor.username, 'ENTRY_STATUS_UPDATED', p.status, iw.refNo);
    return {ok:true};
  },

  my_work: function(p, state){
    var u = requireAuth(state, p.token);
    var mine = state.inward.filter(function(x){ return x.assignedTo===u.id || x.assignedTo===u.username; });
    return {items: mine};
  },

  /* ---- attendance ---- */
  record_attendance: function(p, state){
    var actor = requirePerm(state, p.token, 'attendance_manage');
    var rec = {id:'att_'+Date.now(), date:p.date, personName:p.personName, status:p.status,
      remarks:p.remarks||'', recordedBy:actor.username, createdAt:new Date().toISOString()};
    state.attendance.unshift(rec);
    save('attendance', state.f, state.attendance);
    logAudit(state, actor.username, 'ATTENDANCE_RECORDED', p.personName+' - '+p.status);
    return {ok:true};
  },
  list_attendance: function(p, state){
    requirePerm(state, p.token, 'attendance_view');
    return {attendance: state.attendance};
  },

  /* ---- storage ---- */
  upload_file: function(p, state){
    var actor = requirePerm(state, p.token, 'storage_modify');
    var folder = p.folderId ? DriveApp.getFolderById(p.folderId) : state.f.attachments;
    var bytes = Utilities.base64Decode(p.base64Data);
    var blob = Utilities.newBlob(bytes, p.mimeType||'application/octet-stream', p.fileName);
    var file = folder.createFile(blob);
    try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
    logAudit(state, actor.username, 'FILE_UPLOADED', p.fileName, p.linkedRecordId||'');
    return {ok:true, id:file.getId(), name:file.getName(), url:file.getUrl(), folderId:folder.getId(), folderName:folder.getName()};
  },

  rename_file: function(p, state){
    var actor = requirePerm(state, p.token, 'storage_modify');
    var file = DriveApp.getFileById(p.fileId);
    var old = file.getName();
    file.setName(p.newName);
    logAudit(state, actor.username, 'FILE_RENAMED', old+' -> '+p.newName);
    return {ok:true};
  },

  /* recursive folder tree under the "Folders" area, for pickers */
  list_folder_tree: function(p, state){
    requireAuth(state, p.token);
    var out = [
      {id: state.f.folders.getId(), name:'Storage (root)', path:'Storage (root)'},
      {id: state.f.attachments.getId(), name:'Attachments (default)', path:'Attachments (default)'}
    ];
    function walk(folder, path, depth){
      if (depth > 6) return;
      var it = folder.getFolders();
      while (it.hasNext()){
        var sub = it.next();
        var p2 = path+' / '+sub.getName();
        out.push({id: sub.getId(), name: sub.getName(), path: p2});
        walk(sub, p2, depth+1);
      }
    }
    walk(state.f.folders, 'Storage (root)', 0);
    return {folders: out};
  },

  /* search files by name across Attachments + all custom Storage subfolders */
  search_files: function(p, state){
    requireAuth(state, p.token);
    var term = (p.term||'').toLowerCase();
    var results = [];
    function collect(folder, path, depth){
      if (depth > 6) return;
      var files = folder.getFiles();
      while (files.hasNext()){
        var f = files.next();
        if (!term || f.getName().toLowerCase().indexOf(term) !== -1){
          results.push({id:f.getId(), name:f.getName(), url:f.getUrl(), updated:f.getLastUpdated().toISOString(), size:f.getSize(), folderPath:path, folderId:folder.getId()});
        }
      }
      var subs = folder.getFolders();
      while (subs.hasNext()){
        var sub = subs.next();
        collect(sub, path ? (path+' / '+sub.getName()) : sub.getName(), depth+1);
      }
    }
    collect(state.f.attachments, 'Attachments', 0);
    collect(state.f.folders, 'Storage', 0);
    results.sort(function(a,b){ return new Date(b.updated) - new Date(a.updated); });
    return {files: results.slice(0, 300)};
  },
  list_files: function(p, state){
    requirePerm(state, p.token, 'storage_view');
    var folder = p.folderId ? DriveApp.getFolderById(p.folderId) : state.f.attachments;
    var it = folder.getFiles();
    var out = [];
    while (it.hasNext()){
      var f = it.next();
      out.push({id:f.getId(), name:f.getName(), url:f.getUrl(), updated:f.getLastUpdated().toISOString(), size:f.getSize()});
    }
    return {files: out};
  },
  create_folder: function(p, state){
    var actor = requireAdmin(state, p.token);
    var parent = p.parentId ? DriveApp.getFolderById(p.parentId) : state.f.folders;
    var nf = parent.createFolder(p.name);
    state.folders.push({id:nf.getId(), name:p.name, parentId:p.parentId||state.f.folders.getId()});
    save('folders', state.f, state.folders);
    logAudit(state, actor.username, 'FOLDER_CREATED', p.name);
    return {ok:true, id:nf.getId()};
  },
  list_folders: function(p, state){
    requirePerm(state, p.token, 'storage_view');
    return {folders: state.folders, rootId: state.f.folders.getId()};
  },

  /* ---- dashboard / audit ---- */
  dashboard_stats: function(p, state){
    requireAuth(state, p.token);
    var byStatus = {};
    state.inward.forEach(function(x){ byStatus[x.status]=(byStatus[x.status]||0)+1; });
    var active=0, inactive=0;
    state.users.forEach(function(u){ u.accessStatus==='active'?active++:inactive++; });
    var today = new Date().toISOString().slice(0,10);
    var present=0, absent=0;
    state.attendance.filter(function(a){return a.date===today;}).forEach(function(a){ a.status==='Present'?present++:absent++; });
    return {
      inwardTotal: state.inward.length, inwardByStatus: byStatus,
      outwardTotal: state.outward.length,
      employeesTotal: state.users.length, activeEmployees:active, inactiveEmployees:inactive,
      attendanceToday: {present:present, absent:absent}
    };
  },
  audit_log: function(p, state){
    requireAdmin(state, p.token);
    return {audit: state.audit.slice(0, 300)};
  }
};

function doPost(e){
  var out;
  try{
    var p = JSON.parse(e.postData.contents);
    var state = loadAll();
    var fn = ACTIONS[p.action];
    if (!fn) throw new Error('UNKNOWN_ACTION');
    out = fn(p, state);
  }catch(err){
    out = {error: err.message};
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e){
  return ContentService.createTextOutput(JSON.stringify({ok:true, msg:'Records API is running. Use POST.'})).setMimeType(ContentService.MimeType.JSON);
}
