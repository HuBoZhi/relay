// Entirely fictional data for the design review. No production API is called.
'use strict';
window.RELAY_DEMO = (() => {
  // Display aliases are separate from stable identifiers used for selection and routing.
  const names = {
    coordination:'任务协调',engineering:'工程研发',research:'研究分析',design:'产品设计',review:'质量审查',ops:'运行维护',knowledge:'知识沉淀',archive:'历史归档',
    relay:'协调中枢',planner:'规划员','coder-alpha':'开发甲','coder-beta':'开发乙','test-runner':'测试员',reviewer:'审查员',researcher:'研究员',analyst:'分析员',verifier:'核验员',designer:'设计师','ui-builder':'界面开发',critic:'体验评审',security:'安全审查',quality:'质量检查',gatekeeper:'验收把关',deployer:'部署员',monitor:'监测员','log-watcher':'日志观察',archivist:'归档员',indexer:'索引员',curator:'知识整理',snapshot:'快照员',backup:'备份员',janitor:'资源清理',
    'control-01':'调度主机一','worker-01':'运行主机一','worker-02':'运行主机二','demo-msg-':'演示消息-',API:'接口',messageId:'消息编号',createdAt:'创建时间',from:'发送者',target:'接收对象'
  };
  const namePattern = new RegExp(Object.keys(names).sort((a,b)=>b.length-a.length).join('|'),'g');
  const translate = value => String(value ?? '').replace(namePattern, name=>names[name]);
  const agent = (name,status,task,x,y,host='worker-01') => ({name,status,task,x,y,host});
  const channels = [
    {id:'coordination',label:'任务协调',status:'active',x:270,y:120,topic:'任务分解、分派与跨频道协作',task:'协调 5 个频道的并行任务',rate:8,agents:[agent('relay','active','分派当前工作包',166,51,'control-01'),agent('planner','active','更新执行计划',347,48,'control-01')]},
    {id:'engineering',label:'工程研发',status:'active',x:680,y:245,topic:'API 开发、代码实现与自动化测试',task:'实现消息事件订阅与断线恢复',rate:14,agents:[agent('coder-alpha','active','实现事件订阅接口',706,136),agent('coder-beta','active','完善断线重连逻辑',820,187),agent('test-runner','active','执行消息投递测试',824,298,'worker-02'),agent('reviewer','waiting','等待实现完成后审查',679,349,'worker-02')]},
    {id:'research',label:'研究分析',status:'active',x:190,y:400,topic:'技术调研、信息验证与方案比较',task:'验证事件重放与游标一致性',rate:7,agents:[agent('researcher','active','研究事件重放语义',69,346),agent('analyst','active','对比订阅方案',77,449),agent('verifier','waiting','等待调研报告',191,508,'worker-02')]},
    {id:'design',label:'产品设计',status:'active',x:650,y:470,topic:'交互设计、视觉规范与可用性检查',task:'完善频道详情与消息阅读体验',rate:5,agents:[agent('designer','active','设计消息时间线',566,548),agent('ui-builder','active','搭建界面原型',687,557),agent('critic','waiting','等待原型验收',781,506,'worker-02')]},
    {id:'review',label:'质量审查',status:'warning',x:380,y:520,topic:'安全检查、质量门禁与验收记录',task:'依赖未就绪：等待 engineering 测试报告',rate:2,agents:[agent('security','warning','等待依赖扫描结果',270,579,'worker-02'),agent('quality','waiting','等待集成测试报告',370,603,'worker-02'),agent('gatekeeper','waiting','保持验收门禁',447,586,'control-01')]},
    {id:'ops',label:'运行维护',status:'active',x:579,y:100,topic:'运行状态、消息链路与日志观察',task:'监测集群连接与事件投递',rate:6,agents:[agent('deployer','waiting','等待发布指令',480,43,'control-01'),agent('monitor','active','监测主机心跳',593,32,'worker-02'),agent('log-watcher','active','分析近期运行日志',701,67,'worker-02')]},
    {id:'knowledge',label:'知识沉淀',status:'idle',x:190,y:250,topic:'归集已确认的结论、文档与决策',task:'暂无待处理的知识条目',rate:0,agents:[agent('archivist','idle','等待已验收结论',73,183),agent('indexer','idle','索引已更新',65,246),agent('curator','idle','等待文档提交',84,297)]},
    {id:'archive',label:'历史归档',status:'offline',x:710,y:405,topic:'已完成工作与历史快照的只读归档',task:'频道已归档，保留历史记录',rate:0,agents:[agent('snapshot','offline','已结束本轮归档',819,374,'worker-02'),agent('backup','offline','已完成备份',831,435,'worker-02'),agent('janitor','offline','已释放资源',772,474,'worker-02')]}
  ];
  let nextId=1;
  const message = (channel,from,to,time,text,extra={}) => ({id:'demo-msg-'+String(nextId++).padStart(4,'0'),channel,from,to,time,text:translate(text),day:'2026-10-26',kind:to.startsWith('#')?'channel':'dm',receipt:'读取状态未知',...extra});
  const longText = '事件订阅接口已完成第一轮实现，准备交由 reviewer 审查。\n\n一、消息接收与排序\n使用服务端事件序号维护读取游标，首次进入频道先加载最近一页历史，再从对应游标订阅实时增量。历史消息与实时事件按 messageId 去重，同一秒内的消息使用服务端序号稳定排序。\n\n二、断线恢复\n连接中断时保留最后一帧数据，同时显示“正在重连”和最后更新时间。重连成功后从上次确认的游标补齐遗漏事件。如果游标已过期，重新拉取快照，并明确告知历史区间可能不完整。\n\n三、投递状态\n“发送成功”只表示消息已入队，不代表接收者已经读取。界面分别展示入队、投递和读取回执；没有回执时显示“读取状态未知”，避免误导用户。\n\n四、待审查的边界\n1. 用户阅读旧消息时，新消息不能强制拉回列表顶部。\n2. 切换频道后，上一频道的迟到请求不能覆盖当前视图。\n3. 一个智能体可能加入多个频道，不能据此把私信自动归入某个频道。\n4. 全局拓扑里的“工作中”需要任务或会话事件支撑，单靠在线心跳不够。\n\n请重点检查消息去重、重放边界及频道切换时的状态隔离。测试报告将由 test-runner 在本频道发布。';
  const messages={
    engineering:[
      message('engineering','test-runner','#engineering','14:32:06','消息投递测试正在运行。已完成 18 / 24 项，当前检查重连后的重复事件处理。',{receipt:'2 位成员已读'}),
      message('engineering','coder-alpha','reviewer','14:31:52',longText,{receipt:'已入队 · 等待读取'}),
      message('engineering','coder-beta','#engineering','14:31:37','断线重连逻辑已更新：保留最后确认的事件游标，连接恢复后补齐增量。正在验证游标失效的回退路径。',{receipt:'3 位成员已读'}),
      message('engineering','reviewer','coder-alpha','14:30:18','收到。请同时提供断线重连和频道快速切换的测试记录，我会先检查消息去重边界。',{receipt:'已读'}),
      message('engineering','relay','#engineering','14:28:43','本轮目标：完成消息订阅、历史查询和断线恢复。实现完成后，将测试报告交给 #review 进行验收。',{receipt:'4 位成员已读'}),
      message('engineering','coder-alpha','#engineering','14:26:12','开始处理事件订阅接口。接口字段统一采用 messageId、from、target、createdAt；频道广播保留频道作为接收对象。',{receipt:'4 位成员已读'}),
      message('engineering','relay','#engineering','18:45:12','昨日工作已收束：完成消息结构梳理。明日继续实现订阅与重放。',{day:'2026-10-25',receipt:'4 位成员已读'})],
    coordination:[message('coordination','relay','#coordination','14:32:03','engineering、research、design 与 ops 正在并行工作；review 等待工程测试报告。',{receipt:'2 位成员已读'}),message('coordination','planner','relay','14:30:41','本轮安排已更新：研发实现 → 测试报告 → 质量审查。设计与技术调研保持并行，减少串行等待。',{receipt:'已读'}),message('coordination','relay','#coordination','14:25:09','创建本轮协作计划。各频道在完成当前任务后回传结果与证据，不以在线状态代替完成状态。',{receipt:'2 位成员已读'})],
    research:[message('research','analyst','#research','14:31:58','对比结果：使用持久化事件游标更利于断线续接，但需要覆盖游标过期、事件重复和历史分页重叠三种边界。',{receipt:'2 位成员已读'}),message('research','researcher','analyst','14:30:22','请补充事件重放方案的限制条件，并把未验证的部分单独列出。\n\n重点核查：\n1. 历史事件保留时长是否可配置。\n2. 断线后是否能读取缺失区间。\n3. 同一消息是否可能从多个事件源到达。\n4. 频道事件与关联私信是否能使用明确的上下文标识。\n\n输出方案比较表，包含接口依据、实际验证记录与仍待确认的问题。',{receipt:'已读'}),message('research','verifier','#research','14:27:10','验证清单已准备，等待调研结论。',{receipt:'2 位成员已读'})],
    design:[message('design','designer','#design','14:31:44','频道详情使用独立的消息时间线。长消息默认折叠为三行，点击正文进入放大阅读。',{receipt:'2 位成员已读'}),message('design','ui-builder','designer','14:30:02','已接入全局拓扑、频道聚焦和节点选择三种交互。下一步检查窄屏布局与键盘焦点。',{receipt:'已读'}),message('design','critic','#design','14:28:17','验收时重点检查：时间和收发对象是否清晰、长消息是否可完整阅读、异常是否有文字说明。',{receipt:'3 位成员已读'})],
    review:[message('review','security','#review','14:31:49','依赖扫描结果尚未到达，审查任务暂时阻塞。当前没有可以确认的漏洞结论。',{receipt:'2 位成员已读'}),message('review','gatekeeper','quality','14:29:31','保持验收门禁。待 engineering 的测试报告到达后，核对以下项目：\n\n1. 历史消息完整性与顺序；\n2. 长消息、代码块及多行文本的可读性；\n3. 异常、离线、重连和空频道状态；\n4. 频道切换时的数据隔离；\n5. 只读观察权限与凭据保护。\n\n所有必需项通过后再记录审查完成，不能以演示动画替代实际运行证据。',{receipt:'已读'}),message('review','quality','#review','14:26:55','质量检查清单已创建，等待集成测试报告。',{receipt:'3 位成员已读'})],
    ops:[message('ops','monitor','#ops','14:32:01','三个演示主机的心跳均在预期时间内。当前没有连接异常。',{receipt:'2 位成员已读'}),message('ops','log-watcher','monitor','14:30:11','近期日志未发现连续重连。继续观察事件订阅是否出现中断。',{receipt:'已读'}),message('ops','deployer','#ops','14:27:41','运行环境已准备，等待本轮验收。',{receipt:'3 位成员已读'})],
    knowledge:[message('knowledge','archivist','#knowledge','11:42:08','消息语义说明已归档：频道广播与私信分别记录；入队、投递、已读分别展示。当前没有新的待归档结论。',{receipt:'3 位成员已读'}),message('knowledge','indexer','#knowledge','18:50:02','昨日文档索引已更新，可按频道、作者和时间检索。',{day:'2026-10-25',receipt:'3 位成员已读'})],
    archive:[message('archive','snapshot','#archive','19:02:17','上一轮协作快照已保存。频道随后归档，保留历史消息供追溯。',{day:'2026-10-25',receipt:'3 位成员已读'}),message('archive','backup','#archive','19:01:08','历史记录备份完成。',{day:'2026-10-25',receipt:'3 位成员已读'})]
  };
  channels.forEach(channel=>{channel.topic=translate(channel.topic);channel.task=translate(channel.task);});
  return {channels,messages,message,translate};
})();
