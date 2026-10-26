'use strict';
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon=name=>`<span data-icon="${name}" aria-hidden="true"></span>`;
function icons(root=document){$$('[data-icon]',root).forEach(el=>{const body=window.RELAY_ICONS?.[el.dataset.icon];if(body)el.innerHTML=`<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;});}
const {channels,messages,message,translate:display}=window.RELAY_DEMO;
const labels={active:'执行中',waiting:'等待',idle:'空闲',warning:'异常',offline:'离线'};
const channelLabels={active:'工作中',warning:'待关注',idle:'空闲',offline:'已归档'};
const state={channel:'engineering',filter:'all',search:'',view:'global',tab:'messages',agent:null,paused:false,zoom:1,panX:0,panY:0,expanded:new Set(),total:1284,step:0,dialogId:null,dialogIds:[],elapsed:0,pending:0};
const current=()=>channels.find(channel=>channel.id===state.channel);
const graphChannel=ch=>{
  const offset=ch.id==='design'?32:0;
  return {...ch,y:ch.id==='ops'?116:220+(ch.y-310)*.61+offset,agents:ch.agents.map(a=>({...a,x:a.name==='reviewer'?584:a.name==='planner'?366:a.name==='deployer'?454:a.x,y:220+(a.y-310)*.61+offset}))};
};
const initials=name=>name==='coder-alpha'?'甲':name==='coder-beta'?'乙':display(name).slice(0,1);
const allMessages=()=>Object.values(messages).flat();
const getMessage=id=>allMessages().find(item=>item.id===id);
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
function renderChannels(){
  const list=channels.filter(ch=>(state.filter==='all'||ch.status===state.filter)&&`${ch.id} ${ch.label}`.toLowerCase().includes(state.search.toLowerCase()));
  $('#channel-list').innerHTML=list.length?list.map((ch,index)=>`<button class="channel-item ${ch.id===state.channel?'selected':''}" data-channel="${ch.id}" data-status="${ch.status}" aria-pressed="${ch.id===state.channel}" aria-label="${ch.label}，${channelLabels[ch.status]}"><span class="hash">#</span><span class="channel-info"><strong>${ch.label}</strong><small><i class="status-dot ${ch.status}"></i>${ch.agents.length} 个智能体<span>· ${channelLabels[ch.status]}</span></small></span><span class="channel-spark" aria-hidden="true">${[5,11,7,17,12].map((height,i)=>`<i style="height:${ch.rate?height+(index+i)%3:3+i%2}px"></i>`).join('')}</span></button>`).join(''):'<p class="empty-state">未找到匹配的频道</p>';
}
function selectChannel(id,agent=null){
  if(!channels.some(ch=>ch.id===id))return;
  const changed=id!==state.channel;state.channel=id;state.agent=agent;
  state.zoom=1;state.panX=0;state.panY=0;state.pending=0;
  if(changed){$('#message-search').value='';$('#date-filter').value=id==='archive'?'all':'today';state.expanded.clear();}
  const select=$('#sender-filter'),previous=changed?'all':select.value;
  const senders=[...new Set(messages[id].map(item=>item.from))];
  select.innerHTML='<option value="all">全部发送者</option>'+senders.map(name=>`<option value="${name}">${display(name)}</option>`).join('');
  select.value=senders.includes(previous)?previous:'all';
  renderChannels();renderGraph();renderSummary();renderMessages();renderAgents();setTab(agent?'agents':'messages');
  if(changed)$('#message-timeline').scrollTop=0;
}
function renderSummary(){
  const ch=current(),working=ch.agents.filter(a=>a.status==='active').length;
  $('#channel-summary').innerHTML=`<div class="channel-summary"><div class="channel-eyebrow"><span class="eyebrow">频道状态与详情</span><span class="channel-status ${ch.status}"><i class="status-dot ${ch.status}"></i>${channelLabels[ch.status]}</span></div><div class="channel-title"><h2><span>#</span>${ch.label}</h2><button class="icon-button" id="focus-channel" aria-label="在拓扑中聚焦 ${ch.label}" title="聚焦此频道">${icon('focus')}</button></div><p>${ch.topic}</p><div class="channel-people"><div class="avatar-stack" aria-hidden="true">${ch.agents.map(a=>`<span class="avatar">${initials(a.name)}</span>`).join('')}</div><span>${ch.agents.length} 个智能体</span><small>${working} 个执行中</small></div><div class="channel-task ${ch.status}">${icon(ch.status==='warning'?'triangle-alert':ch.status==='active'?'activity':'clock-3')}<span>${ch.task}</span></div></div>`;
  $('#agent-count').textContent=ch.agents.length;icons($('#channel-summary'));$('#focus-channel').onclick=()=>setView('channel');
}
const defs=`<defs><filter id="small-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><filter id="selected-glow" x="-50%" y="-100%" width="200%" height="300%"><feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#6df5de" flood-opacity=".12"/></filter><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="#6dbab4" stroke-width="1.3"/></marker><marker id="arrow-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="#d2a46c" stroke-width="1.3"/></marker></defs>`;
function route(ch){
  const dx=ch.x-450,dy=ch.y-220,length=Math.hypot(dx,dy),ux=dx/length,uy=dy/length;
  const clearance=Math.min(76/Math.abs(ux||.001),29/Math.abs(uy||.001));
  const sx=450+ux*67,sy=220+uy*67,ex=ch.x-ux*clearance,ey=ch.y-uy*clearance;
  return `M ${sx} ${sy} C ${sx+(ex-sx)*.55} ${sy} ${ex-(ex-sx)*.4} ${ey} ${ex} ${ey}`;
}
const packet=(id,duration,delay,warning=false)=>`<circle class="packet ${warning?'warning':''}" r="2.3"><animateMotion dur="${duration}s" begin="-${delay}s" repeatCount="indefinite"><mpath href="#${id}"/></animateMotion></circle>`;
function channelNode(ch,index){
  const selected=ch.id===state.channel,inactive=['idle','offline'].includes(ch.status);
  return `<g class="graph-channel ${selected?'selected':''} ${ch.status==='warning'?'warning':''} ${inactive?'inactive':''}" data-graph-channel="${ch.id}" role="button" tabindex="0" aria-label="选择频道 ${ch.label}，${channelLabels[ch.status]}" aria-pressed="${selected}" transform="translate(${ch.x} ${ch.y})"><title>#${ch.label} · ${channelLabels[ch.status]}</title><rect class="channel-shape" x="-77" y="-28" width="154" height="56" rx="7"/><text x="-63" y="-5" class="channel-name"># ${ch.label}</text><text x="-63" y="15" class="channel-caption">${channelLabels[ch.status]} · ${ch.agents.length} 个节点</text><circle cx="62" cy="-13" r="2.5" fill="${ch.status==='warning'?'#deb375':inactive?'#667985':'#7ce7d5'}"/><text x="58" y="17" class="channel-number">${String(index+1).padStart(2,'0')}</text></g>`;
}
function agentNode(a,ch,focus=false){
  const hitArea=focus?'<rect class="node-hit-target" x="-88" y="-28" width="176" height="126" fill="transparent"/>':'';
  return `<g class="agent-node ${a.status} ${state.agent===a.name?'selected':''}" data-graph-agent="${a.name}" data-owner-channel="${ch.id}" role="button" tabindex="0" aria-label="查看智能体 ${display(a.name)}，${labels[a.status]}，${a.task}" transform="translate(${a.x} ${a.y})"><title>${display(a.name)} · ${labels[a.status]} · ${a.task}</title>${hitArea}${a.status==='active'?`<circle class="node-halo" r="${focus?26:15}"/>`:''}<circle class="node-shell" r="${focus?20:10}"/><text class="node-initial" y="3" style="font-size:${focus?11:7}px">${initials(a.name)}</text><text class="${focus?'focus-node-label':'node-label'} ${ch.id===state.channel?'selected':''}" y="${focus?47:25}">${display(a.name)}</text>${focus?`<text class="focus-task" y="67">${a.task}</text><text class="focus-status" y="85">${labels[a.status]} · ${display(a.host)}</text>`:''}</g>`;
}
function renderGraph(){
  let html='';
  if(state.view==='global'){
    html+='<ellipse class="network-orbit" cx="450" cy="220" rx="287" ry="128"/><ellipse class="network-ring" cx="450" cy="220" rx="314" ry="148"/><path d="M 450 35 V 420 M 70 220 H 830" stroke="#24434b" opacity=".25" stroke-dasharray="3 8"/>';
    channels.map(graphChannel).forEach((ch,index)=>{
      const active=['active','warning'].includes(ch.status);
      html+=`<path id="flow-${ch.id}" class="channel-link ${ch.id===state.channel?'selected':''} ${ch.status==='warning'?'warning':''} ${active?'':'inactive'}" d="${route(ch)}" marker-end="url(#${ch.status==='warning'?'arrow-amber':'arrow'})"/>`;
      if(active)html+=packet(`flow-${ch.id}`,4+index*.4,index*.8,ch.status==='warning');
      ch.agents.forEach((a,i)=>{const id=`link-${ch.id}-${i}`;html+=`<path id="${id}" class="agent-link ${a.status==='active'?'':'inactive'}" d="M ${ch.x} ${ch.y} Q ${a.x} ${ch.y} ${a.x} ${a.y}"/>`;if(a.status==='active')html+=packet(id,3+i*.6,index+i);});
    });
    html+='<g class="relay-core"><circle class="core-ring" cx="450" cy="220" r="68"/><circle class="core-ring-dashed" cx="450" cy="220" r="62"/><circle class="core-shell" cx="450" cy="220" r="53"/><circle cx="450" cy="220" r="47" fill="none" stroke="#31656a" stroke-width=".6"/><path d="M 435 195 H 465 M 445 191 H 455" stroke="#8fe5d2" stroke-width="1.2"/><text class="core-label" x="453" y="224">协作中枢</text><text class="core-subtitle" x="451" y="241">工作空间</text><circle class="core-pin" cx="450" cy="288" r="3"/><text class="core-status" x="450" y="307">工作空间 · 逻辑聚合</text></g>';
    channels.map(graphChannel).forEach((ch,i)=>{html+=channelNode(ch,i);ch.agents.forEach(a=>html+=agentNode(a,ch));});
  }else{
    const ch=current(),positions=ch.agents.length===2?[[200,310],[700,310]]:ch.agents.length===3?[[450,115],[200,420],[700,420]]:[[210,150],[690,150],[210,450],[690,450]];
    html+=`<ellipse class="network-ring" cx="450" cy="300" rx="285" ry="210"/><text x="450" y="34" text-anchor="middle" fill="#6f959f" font-size="11">频道聚焦 / ${ch.label}</text>`;
    ch.agents.forEach((a,i)=>{const [x,y]=positions[i];html+=`<path id="focus-${i}" class="channel-link ${a.status==='active'?'selected':'inactive'}" d="M 450 300 Q ${x} 300 ${x} ${y}" marker-end="url(#arrow)"/>`;if(a.status==='active')html+=packet(`focus-${i}`,3.5,i);});
    html+=`<rect x="327" y="257" width="246" height="86" rx="9" fill="#16363a" stroke="#6dbbb6"/><text x="450" y="292" text-anchor="middle" fill="#d1fbf2" font-size="21"># ${ch.label}</text><text x="450" y="320" text-anchor="middle" fill="#86b8b1" font-size="11">${channelLabels[ch.status]} · ${ch.agents.length} 个参与智能体</text>`;
    ch.agents.forEach((a,i)=>html+=agentNode({...a,x:positions[i][0],y:positions[i][1]},ch,true));
  }
  $('#network').setAttribute('viewBox',state.view==='global'?'0 0 900 440':'0 0 900 620');
  $('#network').innerHTML=`<title>系统频道与智能体逻辑拓扑</title>${defs}<g id="graph-camera">${html}</g>`;
  $('#network').classList.toggle('paused',state.paused);updateZoom();syncMotion();
}
function updateZoom(){
  const cy=state.view==='global'?220:310;
  $('#graph-camera')?.setAttribute('transform',`translate(${450+state.panX} ${cy+state.panY}) scale(${state.zoom}) translate(-450 ${-cy})`);
  $('#zoom-value').textContent=Math.round(state.zoom*100)+'%';$('#zoom-out').disabled=state.zoom<=.7;$('#zoom-in').disabled=state.zoom>=1.8;
}
function setView(view){state.view=view;state.zoom=1;state.panX=0;state.panY=0;$$('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-pressed',String(b.dataset.view===view));});renderGraph();}
function syncMotion(){const svg=$('#network');if(state.paused||reduced.matches)svg.pauseAnimations?.();else svg.unpauseAnimations?.();}
reduced.addEventListener('change',syncMotion);
function visibleMessages(){
  const query=$('#message-search').value.trim().toLowerCase(),sender=$('#sender-filter').value,date=$('#date-filter').value;
  return messages[state.channel].filter(m=>(sender==='all'||m.from===sender)&&(date==='all'||m.day===(date==='today'?'2026-10-26':'2026-10-25'))&&`${m.text} ${display(m.from)} ${display(m.to)} ${m.from} ${m.to}`.toLowerCase().includes(query));
}
function renderMessages(){
  const list=visibleMessages();let day='';state.pending=0;$('#pending-messages')?.remove();
  $('#message-count').textContent=messages[state.channel].length;
  $('#message-timeline').innerHTML=list.length?list.map(m=>{
    let heading='';if(day!==m.day){day=m.day;heading=`<div class="day-separator">${m.day.replaceAll('-','.')} · 北京时间</div>`;}
    const long=m.text.length>130||m.text.split('\n').length>3,expanded=state.expanded.has(m.id);
    return `${heading}<article class="message" data-message-id="${m.id}"><div class="message-meta"><time datetime="${m.day}T${m.time}+08:00">${m.time}</time><span class="message-kind">${m.kind==='dm'?'关联私信':'频道消息'}</span><button class="icon-button" data-open-message="${m.id}" aria-label="放大阅读 ${m.time} ${display(m.from)} 的消息" title="放大阅读">${icon('expand')}</button></div><div class="message-route"><strong>${esc(display(m.from))}</strong><span class="arrow">→</span><span class="recipient">${esc(display(m.to))}</span></div><button class="message-body ${long&&!expanded?'collapsed':''}" data-open-message="${m.id}" aria-label="放大阅读消息正文：${esc(m.text.slice(0,32))}">${esc(m.text)}</button><div class="message-footer-row">${long?`<button class="message-expand" data-expand-message="${m.id}" aria-expanded="${expanded}">${expanded?'收起全文':`展开全文 · ${m.text.length} 字`}${icon(expanded?'chevron-up':'chevron-down')}</button>`:'<span></span>'}<span class="message-read">${icon(m.receipt.includes('已读')?'check-check':'clock-3')}${esc(m.receipt)}</span></div></article>`;
  }).join(''):`<div class="empty-state"><strong>暂无匹配的消息</strong>${$('#date-filter').value!=='all'?'可切换「全部历史」查看更早记录。':'可尝试清除搜索或发送者筛选。'}</div>`;
  icons($('#message-timeline'));
}
function renderAgents(){
  const ch=current();$('#agents-panel').innerHTML=`<p class="agent-list-note">${ch.agents.length} 个智能体参与此频道。<br>下方展示当前任务与所属运行主机。</p>${ch.agents.map(a=>`<button class="agent-card ${state.agent===a.name?'selected':''}" data-agent-detail="${a.name}" aria-pressed="${state.agent===a.name}"><div class="agent-card-title"><i class="status-dot ${a.status}"></i><strong>${display(a.name)}</strong><small>${labels[a.status]}</small></div><p>${a.task}</p><div class="agent-meta"><span>${display(a.host)}</span><span>${a.status==='offline'?'离线':'在线'}</span></div>${state.agent===a.name?`<div class="agent-note">所属频道：#${ch.label}<br>工作状态依据：演示任务事件<br>最近活动：${a.status==='offline'?'2026-10-25 19:02:17':'2026-10-26 14:32:01'}</div>`:''}</button>`).join('')}`;
}
function setTab(tab){state.tab=tab;['messages','agents'].forEach(name=>{const active=tab===name;$(`#${name}-tab`).classList.toggle('active',active);$(`#${name}-tab`).setAttribute('aria-selected',String(active));$(`#${name}-tab`).tabIndex=active?0:-1;$(`#${name}-panel`).hidden=!active;});}
let dialogOpener=null;
function openMessage(id){
  const m=getMessage(id);if(!m)return;state.dialogId=id;
  const visible=visibleMessages();state.dialogIds=visible.some(item=>item.id===id)?visible.map(item=>item.id):messages[m.channel].map(item=>item.id);
  dialogOpener=document.activeElement;renderDialog();$('#message-dialog').showModal();$('#dialog-close').focus();
}
function renderDialog(){
  const m=getMessage(state.dialogId),index=state.dialogIds.indexOf(m.id);
  $('#dialog-title').textContent=`# ${display(m.channel)} · 消息详情`;
  $('#dialog-meta').innerHTML=`<div class="dialog-route"><strong>${esc(display(m.from))}</strong><span class="arrow">→</span><span>${esc(display(m.to))}</span></div><div class="dialog-meta-line"><time>${m.day} ${m.time} 北京时间</time><span>${m.kind==='dm'?'私信 · 演示数据已明确关联至此频道':'频道广播'}</span><span>${esc(m.receipt)}</span></div><div class="dialog-meta-line mono"><span>${display(m.id)}</span><span>${m.text.length} 字</span><span>演示消息</span></div>`;
  $('#dialog-body').textContent=m.text;$('#dialog-body').scrollTop=0;$('#dialog-position').textContent=`${index+1} / ${state.dialogIds.length}`;
  $('#previous-message').disabled=index===0;$('#next-message').disabled=index===state.dialogIds.length-1;
}
function moveMessage(offset){const index=state.dialogIds.indexOf(state.dialogId)+offset;if(index>=0&&index<state.dialogIds.length){state.dialogId=state.dialogIds[index];renderDialog();}}
function renderRecent(){
  const latest=allMessages().sort((a,b)=>`${b.day} ${b.time}`.localeCompare(`${a.day} ${a.time}`)).slice(0,3);
  $('#recent-activity').innerHTML=latest.map(m=>`<button class="activity-row" data-activity-message="${m.id}" aria-label="查看 ${m.time} ${display(m.from)} 发给 ${display(m.to)} 的消息"><time>${m.time}</time><span class="activity-route"><b>${display(m.from)}</b><em>→</em>${esc(display(m.to))}</span><span class="activity-tag">#${display(m.channel)}</span></button>`).join('');
}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('visible'),2400);}
function toggleLive(){
  state.paused=!state.paused;$('#live-toggle').setAttribute('aria-pressed',String(state.paused));
  $('#live-toggle').innerHTML=`<span class="tiny-dot"></span><span id="live-label">${state.paused?'流转演示已暂停':'流转演示中'}</span>${icon(state.paused?'play':'pause')}`;
  $('#footer-state').textContent=state.paused?'演示已暂停 · 数据保持在当前时刻':'演示事件流已连接';
  $('#topology-live').textContent=state.paused?'已暂停':'实时演示';$('#topology-live').classList.toggle('paused',state.paused);$('#network').classList.toggle('paused',state.paused);icons($('#live-toggle'));syncMotion();
}
const demoEvents=[['engineering','test-runner','消息投递测试仍在运行，正在验证重复事件不会生成重复记录。'],['research','analyst','重放边界已加入方案比较表，继续核对游标过期的处理方式。'],['ops','monitor','演示集群心跳更新：3 台主机在线，事件订阅连接保持正常。'],['design','ui-builder','消息放大阅读交互已就绪，正在检查长文本与键盘导航。'],['coordination','planner','并行工作继续推进，review 仍等待 engineering 的完整测试报告。']];
function simulationTick(){
  if(state.paused||document.hidden)return;state.elapsed++;
  const time=new Date(Date.UTC(2026,9,26,14,32,8+state.elapsed)).toISOString().slice(11,19);$('#system-clock').textContent=time;
  if(state.elapsed%12!==0)return;
  const [channel,from,text]=demoEvents[state.step++%demoEvents.length],item=message(channel,from,`#${channel}`,time,text);
  messages[channel].unshift(item);
  if(messages[channel].length>45){const removable=messages[channel].findLastIndex(m=>m.day==='2026-10-26'&&!state.dialogIds.includes(m.id)&&m.id!==state.dialogId);if(removable>8)messages[channel].splice(removable,1);}
  $('#message-total').textContent=(++state.total).toLocaleString('zh-CN');renderRecent();
  if(channel===state.channel){
    $('#message-count').textContent=messages[channel].length;
    const timeline=$('#message-timeline'),canRefresh=timeline.scrollTop<30&&!timeline.contains(document.activeElement)&&!$('#message-dialog').open;
    if(canRefresh){renderMessages();$(`[data-message-id="${item.id}"]`)?.classList.add('new-message');}
    else{state.pending++;let button=$('#pending-messages');if(!button){button=document.createElement('button');button.id='pending-messages';button.className='pending-messages';button.onclick=()=>{renderMessages();timeline.scrollTop=0;};$('.message-tools').append(button);}button.textContent=`${state.pending} 条新消息 · 点击查看`;}
  }
}
$('#channel-list').onclick=event=>{const button=event.target.closest('[data-channel]');if(button)selectChannel(button.dataset.channel);};
$('#channel-search').oninput=event=>{state.search=event.target.value;renderChannels();};
$$('[data-filter]').forEach(button=>button.onclick=()=>{state.filter=button.dataset.filter;$$('[data-filter]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});renderChannels();});
$$('[data-view]').forEach(button=>button.onclick=()=>setView(button.dataset.view));
$('#overview-button').onclick=()=>{setView('global');$('#network-panel').scrollIntoView({behavior:reduced.matches?'instant':'smooth',block:'nearest'});};
$('#alert-link').onclick=()=>selectChannel('review');
function graphAction(event){const agent=event.target.closest('[data-graph-agent]'),channel=event.target.closest('[data-graph-channel]');if(agent)selectChannel(agent.dataset.ownerChannel,agent.dataset.graphAgent);else if(channel)selectChannel(channel.dataset.graphChannel);}
$('#network').onclick=graphAction;$('#network').onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();graphAction(event);}};
$('#agents-panel').onclick=event=>{const button=event.target.closest('[data-agent-detail]');if(button){state.agent=button.dataset.agentDetail;renderAgents();renderGraph();}};
$('#messages-tab').onclick=()=>{setTab('messages');renderMessages();};$('#agents-tab').onclick=()=>{setTab('agents');renderAgents();};
$('.detail-tabs').onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tab=event.key==='Home'?'messages':event.key==='End'?'agents':state.tab==='messages'?'agents':'messages';setTab(tab);$(`#${tab}-tab`).focus();}};
['message-search','sender-filter','date-filter'].forEach(id=>$(`#${id}`).addEventListener(id==='message-search'?'input':'change',()=>{renderMessages();$('#message-timeline').scrollTop=0;}));
$('#message-timeline').onclick=event=>{
  const expand=event.target.closest('[data-expand-message]');
  if(expand){const id=expand.dataset.expandMessage;state.expanded.has(id)?state.expanded.delete(id):state.expanded.add(id);const top=$('#message-timeline').scrollTop;renderMessages();$('#message-timeline').scrollTop=top;$(`[data-expand-message="${id}"]`)?.focus({preventScroll:true});return;}
  const open=event.target.closest('[data-open-message]');if(open)openMessage(open.dataset.openMessage);
};
$('#recent-activity').onclick=event=>{const button=event.target.closest('[data-activity-message]');if(button)openMessage(button.dataset.activityMessage);};
$('#dialog-close').onclick=()=>$('#message-dialog').close();$('#message-dialog').onclose=()=>{if(dialogOpener?.isConnected)dialogOpener.focus({preventScroll:true});};
$('#previous-message').onclick=()=>moveMessage(-1);$('#next-message').onclick=()=>moveMessage(1);
$('#copy-message').onclick=async()=>{try{await navigator.clipboard.writeText(getMessage(state.dialogId).text);toast('完整消息已复制');}catch{toast('复制不可用，请选中正文手动复制');}};
$('#help-button').onclick=()=>$('#help-dialog').showModal();$('#help-close').onclick=()=>$('#help-dialog').close();
$$('dialog').forEach(dialog=>dialog.onclick=event=>{if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();});
$('#live-toggle').onclick=toggleLive;
$('#zoom-in').onclick=()=>{state.zoom=Math.min(1.8,Math.round((state.zoom+.1)*10)/10);updateZoom();};$('#zoom-out').onclick=()=>{state.zoom=Math.max(.7,Math.round((state.zoom-.1)*10)/10);updateZoom();};$('#zoom-reset').onclick=()=>{state.zoom=1;state.panX=0;state.panY=0;updateZoom();};
$('#fullscreen-button').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('#network-panel').requestFullscreen();}catch{toast('当前浏览器不支持全屏，可使用拓扑缩放');}};
let drag=null;
$('#graph-stage').onpointerdown=event=>{if(event.button!==0||event.target.closest('button,[role="button"]'))return;const rect=$('#network').getBoundingClientRect();drag={x:event.clientX,y:event.clientY,panX:state.panX,panY:state.panY,scale:Math.min(rect.width/900,rect.height/(state.view==='global'?440:620))};$('#graph-stage').setPointerCapture(event.pointerId);$('#graph-stage').classList.add('dragging');};
$('#graph-stage').onpointermove=event=>{if(!drag)return;state.panX=drag.panX+(event.clientX-drag.x)/drag.scale;state.panY=drag.panY+(event.clientY-drag.y)/drag.scale;updateZoom();};
function endDrag(){drag=null;$('#graph-stage').classList.remove('dragging');}$('#graph-stage').onpointerup=endDrag;$('#graph-stage').onpointercancel=endDrag;
document.onkeydown=event=>{if(event.target.closest('input,textarea,select')||$('dialog[open]')||event.ctrlKey||event.metaKey||event.altKey)return;if(event.key==='/'){event.preventDefault();$('#channel-search').focus();}else if(event.key.toLowerCase()==='g')setView('global');};
const traffic=[15,23,18,28,22,13,20,29,23,33,25,22,28,18,27,31,26,19,30,23,29,35,24,31,34,29,37,32,26,33,38,29,37,30,34,42];
$('#traffic-chart').innerHTML=traffic.map((value,i)=>`<i style="height:${value/44*100}%" title="演示区间 ${i+1}：${value} 条/分钟"></i>`).join('');
$('#traffic-chart').setAttribute('role','img');$('#traffic-chart').setAttribute('aria-label','演示消息吞吐趋势：最近12分钟由15条每分钟变化至42条每分钟。');
$('.cluster-bars').innerHTML=Array.from({length:24},(_,i)=>`<i style="height:${6+(i*7+5)%15}px"></i>`).join('');
$('#active-agent-count').textContent=channels.flatMap(ch=>ch.agents).filter(a=>a.status==='active').length;
icons();selectChannel('engineering');renderRecent();setInterval(simulationTick,1000);
