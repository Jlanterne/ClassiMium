(() => {
  const $stage = document.getElementById('pc_stage');
  if (!$stage) return;

  const conf = window.SEATING_CONF || {};
  const classeId = conf.classeId || parseInt($stage.dataset.classeId, 10);
  const API_BASE = (conf.apiBase || "/seating") + "/api";
  const PHOTOS_BASE = conf.photosBase || "/static/photos/";

  const grid = 32; let scale = 1;
  let state = { plans:[], active_plan:null, furniture:[], positions:[], seats:[], eleves:[] };

  const $sel  = document.getElementById('pc_plan_select');
  const $new  = document.getElementById('pc_new_plan');
  const $dup  = document.getElementById('pc_duplicate');
  const $act  = document.getElementById('pc_activate');
  const $pdf  = document.getElementById('pc_export_pdf');
  const $zoom = document.getElementById('pc_zoom');
  const $full = document.getElementById('pc_fullscreen');
  const $elist= document.getElementById('pc_eleve_list');
  const $wrap = $stage.parentElement;

  const api = {
    getAll: () => fetch(`${API_BASE}/plans/${classeId}`).then(r=>r.json()),
    create: (payload) => fetch(`${API_BASE}/plans`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)}).then(r=>r.json()),
    activate: (plan_id) => fetch(`${API_BASE}/plans/${plan_id}/activate`, {method:'PUT'}).then(r=>r.json()),
    duplicate: (plan_id) => fetch(`${API_BASE}/plans/${plan_id}/duplicate`, {method:'POST'}).then(r=>r.json()),
    savePositions: (plan_id, items) => fetch(`${API_BASE}/plans/${plan_id}/positions`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({positions:items})}).then(r=>r.json()),
    saveFurniture: (plan_id, items) => fetch(`${API_BASE}/plans/${plan_id}/furniture`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({furniture:items})}).then(r=>r.json()),
  };

  const debounce=(fn,d=600)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),d);};};
  const autosavePositions=debounce(()=>{if(state.active_plan) api.savePositions(state.active_plan.id,state.positions).catch(console.error);},700);
  const autosaveFurniture=debounce(()=>{if(state.active_plan) api.saveFurniture(state.active_plan.id,state.furniture).catch(console.error);},700);

  const snapUnit=px=>Math.round(px/(grid*scale));
  const toPx=u=>(u*grid*scale)|0;
  const moyClass=m20=>m20==null?'':(m20>=16?'mAp':m20>=13?'mA':m20>=8?'mPA':'mNA');

  function renderPlansSelect(){
    $sel.innerHTML='';
    state.plans.forEach(p=>{
      const o=document.createElement('option');
      o.value=p.id;
      o.textContent=(p.is_active?'★ ':'')+`${p.name} — ${new Date(p.created_at).toLocaleDateString()}`;
      if(state.active_plan && p.id===state.active_plan.id) o.selected=true;
      $sel.appendChild(o);
    });
  }

  function resizeStage(){
    if(!state.active_plan) return;
    $stage.style.width=toPx(state.active_plan.width)+'px';
    $stage.style.height=toPx(state.active_plan.height)+'px';
  }

  function clearStage(){ $stage.querySelectorAll('.pc_card,.pc_furn').forEach(n=>n.remove()); }

  function renderEleveList(){
    $elist.innerHTML='';
    const placed=new Set(state.positions.map(p=>p.eleve_id));
    state.eleves.forEach(e=>{
      if(placed.has(e.id)) return;
      const item=document.createElement('div'); item.className='pc_eleve_item'; item.dataset.eleveId=e.id;
      const img=document.createElement('img'); img.src=PHOTOS_BASE+(e.photo_filename||'default.jpg');
      const name=document.createElement('div'); name.className='name'; name.textContent=`${e.prenom} ${e.nom}`;
      item.append(img,name); item.addEventListener('pointerdown', startDragFromList); $elist.appendChild(item);
    });
  }

  function addCard(e,pos){
    const card=document.createElement('div'); card.className='pc_card';
    card.dataset.eleveId=e.id; card.dataset.sexe=e.sexe||''; if(e.niveau) card.dataset.niveau=e.niveau;
    card.style.left=toPx(pos.x)+'px'; card.style.top=toPx(pos.y)+'px';
    const img=document.createElement('img'); img.src=PHOTOS_BASE+(e.photo_filename||'default.jpg');
    const bSex=document.createElement('div'); bSex.className='badge sex'; bSex.textContent=(e.sexe==='MASCULIN'?'♂':e.sexe==='FEMININ'?'♀':'?');
    const bM=document.createElement('div'); bM.className=`badge moy ${moyClass(e.moyenne_20)}`; bM.textContent=(e.moyenne_20!=null)?Math.round(e.moyenne_20):'—';
    card.append(img,bSex,bM); $stage.appendChild(card); card.addEventListener('pointerdown', startDragCard);
  }

  function renderFurniture(){
    state.furniture.forEach(f=>{
      const el=document.createElement('div'); el.className='pc_furn'; el.dataset.id=f.id||''; el.dataset.type=f.type;
      el.style.left=toPx(f.x)+'px'; el.style.top=toPx(f.y)+'px';
      el.style.width=toPx(f.w)+'px'; el.style.height=toPx(f.h)+'px';
      const label=document.createElement('div'); label.className='label'; label.textContent=f.label||f.type;
      const rs=document.createElement('div'); rs.className='resize'; el.append(label,rs); $stage.appendChild(el);
      el.addEventListener('pointerdown', startDragFurniture); rs.addEventListener('pointerdown', startResizeFurniture);
    });
  }

  function render(){
    renderPlansSelect(); clearStage(); resizeStage();
    const posById={}; state.positions.forEach(p=>posById[p.eleve_id]=p);
    state.eleves.forEach(e=>{ if(posById[e.id]) addCard(e,posById[e.id]); });
    renderEleveList(); renderFurniture();
  }

  // Drag depuis la liste
  let dragData=null;
  function startDragFromList(ev){
    dragData={kind:'fromList', eleveId:parseInt(ev.currentTarget.dataset.eleveId,10)};
    window.addEventListener('pointerup', endDragFromList, {once:true});
  }
  function endDragFromList(ev){
    const r=$stage.getBoundingClientRect();
    if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom){ dragData=null; return; }
    const gx=snapUnit((ev.clientX-r.left)/scale), gy=snapUnit((ev.clientY-r.top)/scale);
    state.positions.push({eleve_id:dragData.eleveId,x:gx,y:gy,seat_id:null}); autosavePositions(); dragData=null; render();
  }

  // Drag d'une carte élève
  function startDragCard(ev){
    const card=ev.currentTarget;
    dragData={kind:'card', eleveId:parseInt(card.dataset.eleveId,10), startLeft:parseInt(card.style.left||'0',10), startTop:parseInt(card.style.top||'0',10), sx:ev.clientX, sy:ev.clientY};
    card.setPointerCapture(ev.pointerId); card.addEventListener('pointermove', onDragCardMove); card.addEventListener('pointerup', endDragCard, {once:true});
  }
  function onDragCardMove(ev){
    const card=ev.currentTarget;
    card.style.left=(dragData.startLeft+(ev.clientX-dragData.sx))+'px';
    card.style.top =(dragData.startTop +(ev.clientY-dragData.sy))+'px';
  }
  function endDragCard(ev){
    const card=ev.currentTarget;
    card.releasePointerCapture(ev.pointerId); card.removeEventListener('pointermove', onDragCardMove);
    const lx=parseInt(card.style.left||'0',10), ly=parseInt(card.style.top||'0',10);
    const gx=snapUnit(lx/scale), gy=snapUnit(ly/scale);
    const p=state.positions.find(p=>p.eleve_id===dragData.eleveId);
    if(p){ p.x=gx; p.y=gy; }else{ state.positions.push({eleve_id:dragData.eleveId,x:gx,y:gy,seat_id:null}); }
    autosavePositions(); dragData=null; render();
  }

  // Meubles: drag & resize
  function startDragFurniture(ev){
    if(ev.target.classList.contains('resize')) return;
    const el=ev.currentTarget;
    dragData={kind:'furn', id:el.dataset.id?parseInt(el.dataset.id,10):null, startLeft:parseInt(el.style.left||'0',10), startTop:parseInt(el.style.top||'0',10), sx:ev.clientX, sy:ev.clientY, el};
    el.setPointerCapture(ev.pointerId); el.addEventListener('pointermove', onDragFurnitureMove); el.addEventListener('pointerup', endDragFurniture, {once:true});
  }
  function onDragFurnitureMove(ev){
    const el=ev.currentTarget;
    el.style.left=(dragData.startLeft+(ev.clientX-dragData.sx))+'px';
    el.style.top =(dragData.startTop +(ev.clientY-dragData.sy))+'px';
  }
  function endDragFurniture(ev){
    const el=ev.currentTarget;
    el.releasePointerCapture(ev.pointerId); el.removeEventListener('pointermove', onDragFurnitureMove);
    const lx=parseInt(el.style.left||'0',10), ly=parseInt(el.style.top||'0',10);
    const gx=snapUnit(lx/scale), gy=snapUnit(ly/scale);
    const id=dragData.id;
    if(id){ const f=state.furniture.find(x=>x.id===id); if(f){ f.x=gx; f.y=gy; } }
    else{
      const type=el.dataset.type||'autre';
      const w=Math.max(1, snapUnit(parseInt(el.style.width||'0',10)/scale));
      const h=Math.max(1, snapUnit(parseInt(el.style.height||'0',10)/scale));
      state.furniture.push({type,label:el.querySelector('.label')?.textContent||type,x:gx,y:gy,w,h,rotation:0,z:0});
    }
    autosaveFurniture(); dragData=null; render();
  }

  function startResizeFurniture(ev){
    const el=ev.currentTarget.parentElement;
    dragData={kind:'resize', id:el.dataset.id?parseInt(el.dataset.id,10):null, startW:parseInt(el.style.width||'0',10), startH:parseInt(el.style.height||'0',10), sx:ev.clientX, sy:ev.clientY, el};
    el.setPointerCapture(ev.pointerId); el.addEventListener('pointermove', onResizeFurnitureMove); el.addEventListener('pointerup', endResizeFurniture, {once:true}); ev.stopPropagation();
  }
  function onResizeFurnitureMove(ev){
    const el=ev.currentTarget;
    el.style.width =Math.max(32, dragData.startW+(ev.clientX-dragData.sx))+'px';
    el.style.height=Math.max(32, dragData.startH+(ev.clientY-dragData.sy))+'px';
  }
  function endResizeFurniture(ev){
    const el=ev.currentTarget;
    el.releasePointerCapture(ev.pointerId); el.removeEventListener('pointermove', onResizeFurnitureMove);
    const w=parseInt(el.style.width||'0',10), h=parseInt(el.style.height||'0',10);
    const gw=Math.max(1, snapUnit(w/scale)), gh=Math.max(1, snapUnit(h/scale));
    const id=dragData.id;
    if(id){ const f=state.furniture.find(x=>x.id===id); if(f){ f.w=gw; f.h=gh; } }
    else{
      const type=el.dataset.type||'autre'; const label=el.querySelector('.label')?.textContent||type;
      state.furniture.push({type,label,x:1,y:1,w:gw,h:gh,rotation:0,z:0});
    }
    autosaveFurniture(); dragData=null; render();
  }

  // Toolbar
  document.getElementById('pc_add_furniture')?.addEventListener('click', ()=>{
    if(!state.active_plan) return;
    const type=prompt("Type (table, armoire, porte, fenetre, tableau, tableau_mobile, corbeille, evier, desk, autre):","desk");
    if(!type) return;
    const label=prompt("Label (optionnel):", type);
    state.furniture.push({type,label,x:1,y:1,w:2,h:1,rotation:0,z:0});
    autosaveFurniture(); render();
  });
  $new?.addEventListener('click', async ()=>{
    const name=prompt("Nom du plan :", "Rentrée"); if(!name) return;
    const r=await api.create({classe_id:classeId, name, width:30, height:20, grid_size:32});
    await boot(); if(r.plan_id){ $sel.value=String(r.plan_id); onPlanChange(); }
  });
  $dup?.addEventListener('click', async ()=>{ if(!state.active_plan) return; await api.duplicate(state.active_plan.id); await boot(); });
  $act?.addEventListener('click', async ()=>{ if(!state.active_plan) return; await api.activate(state.active_plan.id); await boot(); });
  $pdf?.addEventListener('click', ()=>{ if(!state.active_plan) return; window.open(`${API_BASE}/plans/${state.active_plan.id}/export/pdf`,'_blank'); });
  function onPlanChange(){ const id=parseInt($sel.value,10); state.active_plan=state.plans.find(p=>p.id===id)||state.active_plan; render(); }
  $sel?.addEventListener('change', onPlanChange);
  $zoom?.addEventListener('input', ()=>{ scale=parseInt($zoom.value,10)/100; $stage.style.transform=`scale(${scale})`; });
  $full?.addEventListener('click', ()=>{ const el=$wrap; if(!document.fullscreenElement) el.requestFullscreen?.(); else document.exitFullscreen?.(); });

  async function boot(){
    const data=await api.getAll();
    state={...state, ...data}; if(!state.active_plan && state.plans.length) state.active_plan=state.plans[0];
    render();
  }
  boot().catch(console.error);
})();
