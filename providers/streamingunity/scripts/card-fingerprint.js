'use strict';
const {hash}=require('../../../shared/storage/json');
const COUNTERS=new Set(['views','daily_views','weekly_views','monthly_views','total_views','views_count',
  'visite','favorites','favorites_count','members','members_count']);
function meaningful(value){
  if(Array.isArray(value))return value.filter(v=>!(v&&typeof v==='object'&&COUNTERS.has(v.key))).map(meaningful);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!COUNTERS.has(k))
    .map(k=>[k,meaningful(value[k])]));
  return value;
}
function cardFingerprint(card){return hash(meaningful(card));}
function activityCounters(card){
  const result={};
  function visit(value,path){
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const entry of value){
      if(entry&&COUNTERS.has(entry.key))result[path+'/'+(entry.locale||'')+'/'+entry.key]=entry.value;
    }return;}
    for(const [key,child] of Object.entries(value)){
      const next=path+'/'+key;if(COUNTERS.has(key))result[next]=child;else visit(child,next);
    }
  }
  visit(card,'');return result;
}
module.exports={cardFingerprint,activityCounters};
