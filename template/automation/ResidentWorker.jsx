#target aftereffects
(function(){
 var root=$.getenv('TELEGRAM_RESIDENT_ROOT'), token=$.getenv('TELEGRAM_RESIDENT_TOKEN');
 if(!root||!token)return;
 function q(s){return '"'+String(s).replace(/[\\"\u0000-\u001f]/g,function(c){if(c==='\\')return '\\\\';if(c==='"')return '\\"';return '\\u'+('0000'+c.charCodeAt(0).toString(16)).slice(-4);})+'"';}
 function j(v){var a=[],i;if(v===null||typeof v==='undefined')return 'null';if(typeof v==='string')return q(v);if(typeof v==='number'||typeof v==='boolean')return String(v);if(v instanceof Array){for(i=0;i<v.length;i++)a.push(j(v[i]));return '['+a.join(',')+']';}for(i in v)if(v.hasOwnProperty(i))a.push(q(i)+':'+j(v[i]));return '{'+a.join(',')+'}';}
 function write(path,value){var f=new File(path);f.encoding='UTF-8';if(!f.open('w'))throw Error('Cannot write '+path);f.write(j(value));f.close();}
 var busy=false; app.setSavePreferencesOnQuit(false);
 function idle(){write(root+'/worker_state.json',{status:'idle',token:token,version:String(app.version)});} 
 $.global.telegramResidentPoll=function(){
  if(busy)return;
  var reqFile=new File(root+'/request.jsxinc');if(!reqFile.exists)return;
  busy=true; var req=null,queueItem=null;
  try{
   req=$.evalFile(reqFile);reqFile.remove();if(!req||req.token!==token)throw Error('Invalid token');
   write(root+'/worker_state.json',{status:'busy',token:token,job:req.id});write(req.status,{status:'building',job:req.id,token:token});
   app.beginSuppressDialogs();app.newProject();$.global.TELEGRAM_AE_AUTOMATION=true;$.global.TELEGRAM_AE_RESULT=null;
   $.evalFile(new File(req.builder));var result=$.global.TELEGRAM_AE_RESULT;if(!result||!result.main)throw Error('Builder did not return composition');
   var main=result.main, i, item;main.resolutionFactor=[1,1];
   for(i=1;i<=app.project.numItems;i++){item=app.project.item(i);if(item instanceof FootageItem && item.file && item.footageMissing)throw Error('Missing footage: '+item.file.fsName);}
   queueItem=app.project.renderQueue.items.add(main);var rs=queueItem.templates;for(i=0;i<rs.length;i++)if(rs[i]==='Best Settings'){queueItem.applyTemplate(rs[i]);break;}
   queueItem.timeSpanStart=0;queueItem.timeSpanDuration=main.duration;queueItem.skipFrames=0;
   var om=queueItem.outputModule(1), templates=om.templates, ts=[];for(i=0;i<templates.length;i++)ts.push(String(templates[i]));
   var found=false;for(i=0;i<ts.length;i++)if(ts[i]==='TIFF Sequence with Alpha')found=true;
   if(!found)throw Error('TIFF Sequence with Alpha is unavailable');om.applyTemplate('TIFF Sequence with Alpha');om.file=new File(req.pattern);
   app.project.save(new File(req.project));
   write(req.result,{status:'ready',aeVersion:String(app.version),project:req.project,comp:main.name,width:main.width,height:main.height,fps:main.frameRate,duration:main.duration,audio:result.audio||null,frames:Math.round(main.duration*main.frameRate),rqIndex:app.project.renderQueue.numItems,outputTemplate:'TIFF Sequence with Alpha',outputFormat:'TIFF',availableOutputTemplates:ts});
   write(req.status,{status:'rendering',job:req.id,token:token,comp:main.name});
   if(typeof app.setMultiFrameRenderingConfig==='function')app.setMultiFrameRenderingConfig(true,req.cpuPercent);
   if(typeof app.setMemoryUsageLimits==='function')app.setMemoryUsageLimits(10,60);
   app.project.renderQueue.render();
   if(queueItem.status!==RQItemStatus.DONE)throw Error('Render queue did not report DONE: '+queueItem.status);
   write(req.status,{status:'done',job:req.id,token:token,comp:main.name,frames:Math.round(main.duration*main.frameRate),project:req.project});
  }catch(e){try{if(req&&req.status)write(req.status,{status:'failed',job:req.id,token:token,error:String(e),line:e.line});else write(root+'/worker_error.json',{error:String(e),line:e.line});}catch(ignored){}}
  finally{$.global.TELEGRAM_AE_AUTOMATION=false;try{app.endSuppressDialogs(false);}catch(ignore2){}busy=false;try{idle();}catch(ignore3){}}
 };
 $.global.telegramResidentTask=app.scheduleTask('$.global.telegramResidentPoll()',500,true);
 write(root+'/worker_ready.json',{status:'ready',token:token,version:String(app.version)});idle();
}());