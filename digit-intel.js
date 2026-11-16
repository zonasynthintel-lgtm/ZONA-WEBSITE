/* ============================================================
   ZONA DIGIT INTELLIGENCE — Strategy Engine + Integration
   Stage 1: observations, windows, DIFFERS, EVEN/ODD, OVER/UNDER, MATCHES stats
   Stage 2: live ticks, AutoTrader signals, digit contract proposals
   Extends existing ZONA — does not replace Trade Engine / AutoTrader
============================================================ */
(function(global){
  "use strict";

  var STORAGE_KEY = "zonaDigitIntel_v1";
  var WINDOW_SIZES = [100, 500, 1000];
  var MAX_HISTORY = 1200;
  var MAX_EVENTS = 80;

  var state = {
    symbol: "R_10",
    paused: false,
    enableDiffers: false,
    enableEvenOdd: false,
    enableOverUnder: false,
    eoTarget: "EVEN",
    eoCount: 3,
    eoMode: "SINGLE",
    ouThreshold: 5,
    ouTarget: "OVER",
    ouCount: 3,
    ouMode: "SINGLE",
    mdDigit: 0,
    perSymbol: {},
    lastSignal: null,
    pendingContract: null,
    executedSignalIds: {}
  };

  function loadSettings(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return;
      var p = JSON.parse(raw);
      if(!p || typeof p !== "object") return;
      ["symbol","paused","enableDiffers","enableEvenOdd","enableOverUnder","eoTarget","eoCount","eoMode","ouThreshold","ouTarget","ouCount","ouMode","mdDigit"].forEach(function(k){
        if(p[k] !== undefined) state[k] = p[k];
      });
    }catch(e){}
  }
  function saveSettings(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        symbol: state.symbol,
        paused: !!state.paused,
        enableDiffers: !!state.enableDiffers,
        enableEvenOdd: !!state.enableEvenOdd,
        enableOverUnder: !!state.enableOverUnder,
        eoTarget: state.eoTarget,
        eoCount: state.eoCount,
        eoMode: state.eoMode,
        ouThreshold: state.ouThreshold,
        ouTarget: state.ouTarget,
        ouCount: state.ouCount,
        ouMode: state.ouMode,
        mdDigit: state.mdDigit
      }));
    }catch(e){}
  }

  function ensureSymbol(sym){
    if(!sym) sym = state.symbol;
    if(!state.perSymbol[sym]){
      state.perSymbol[sym] = {
        observations: [],
        seq: 0,
        lastQuote: null,
        lastDigit: null,
        lastEpoch: null,
        differs: { candidate: null, nextExpected: 0, state: "Collecting Data", sequenceProgress: [] },
        evenOdd: { streak: 0, lastOppositeDigit: null, consumed: false, state: "Collecting Data" },
        overUnder: { streak: 0, lastOppositeDigit: null, consumed: false, state: "Collecting Data" },
        events: []
      };
    }
    return state.perSymbol[sym];
  }

  function extractFinalDigit(quote){
    if(quote === null || quote === undefined) return null;
    var s;
    if(typeof quote === "number"){
      if(!Number.isFinite(quote)) return null;
      s = String(quote);
      if(s.indexOf("e") >= 0 || s.indexOf("E") >= 0){
        s = quote.toFixed(8).replace(/\.?0+$/,"");
      }
    } else {
      s = String(quote).trim();
    }
    if(s.charAt(0) === "-" || s.charAt(0) === "+") s = s.slice(1);
    var digits = s.replace(/[^0-9]/g, "");
    if(!digits.length) return null;
    var d = parseInt(digits.charAt(digits.length - 1), 10);
    if(d < 0 || d > 9 || !Number.isFinite(d)) return null;
    return d;
  }

  function pushEvent(symState, type, detail){
    symState.events.unshift({ t: Date.now(), type: type, detail: detail || "" });
    if(symState.events.length > MAX_EVENTS) symState.events.length = MAX_EVENTS;
  }

  function windowStats(obs, size){
    var n = obs.length;
    var take = Math.min(n, size);
    var slice = obs.slice(n - take);
    var counts = [0,0,0,0,0,0,0,0,0,0];
    for(var i=0;i<slice.length;i++) counts[slice[i].digit]++;
    var pct = counts.map(function(c){ return take ? (c / take) * 100 : 0; });
    return { size: size, count: take, complete: take >= size, counts: counts, pct: pct };
  }

  function uniqueLowestDigit(stats){
    if(!stats.complete) return { digit: null, unique: false, tied: [] };
    var min = Infinity, tied = [];
    for(var d=0;d<=9;d++){
      if(stats.counts[d] < min){ min = stats.counts[d]; tied = [d]; }
      else if(stats.counts[d] === min){ tied.push(d); }
    }
    if(tied.length === 1) return { digit: tied[0], unique: true, tied: tied };
    return { digit: null, unique: false, tied: tied };
  }

  function isEven(d){ return d === 0 || d === 2 || d === 4 || d === 6 || d === 8; }
  function isOver(d, th){ return d > th; }
  function isUnder(d, th){ return d <= th; }

  function uid(){ return "di_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); }

  function emitSignal(sig){
    state.lastSignal = sig;
    state.pendingContract = {
      contract_type: sig.contract_type,
      barrier: sig.barrier,
      direction: sig.direction,
      symbol: sig.symbol,
      signalId: sig.id,
      strategy: sig.strategy
    };
    pushEvent(ensureSymbol(sig.symbol), "Signal generated", sig.strategy + " → " + sig.contract_type + (sig.barrier!=null ? " barrier "+sig.barrier : ""));
    renderUI();
    tryAutoExecute(sig);
  }

  function tryAutoExecute(sig){
    if(!sig || !sig.id) return;
    if(state.executedSignalIds[sig.id]) return;
    if(state.paused) return;
    try{
      if(typeof TRADE === "undefined" || !TRADE.autoTradeEnabled){
        var st = document.getElementById("zonaDIBridgeStatus");
        if(st) st.textContent = "Signal ready ("+sig.strategy+"). Auto Trade is OFF — enable AutoTrader to execute.";
        return;
      }
    }catch(e){ return; }

    var eng = null;
    try{
      if(typeof engines !== "undefined" && engines && engines[sig.symbol]) eng = engines[sig.symbol];
    }catch(e2){}
    if(!eng) eng = { symbol: sig.symbol, name: sig.symbol, active: true, PA: {}, TT: {} };
    var sub = eng.PA || {};
    var direction = sig.direction === "SELL" ? "SELL" : "BUY";
    var zone = { _digitContract: { contract_type: sig.contract_type, barrier: sig.barrier } };
    state.executedSignalIds[sig.id] = true;
    var keys = Object.keys(state.executedSignalIds);
    if(keys.length > 200){
      keys.slice(0, keys.length - 150).forEach(function(k){ delete state.executedSignalIds[k]; });
    }
    try{
      if(typeof tryAutoTrade === "function"){
        tryAutoTrade(eng, sub, direction, zone, null, "DIGIT_INTEL", Date.now(), "DIGIT_INTEL");
      } else if(typeof global.tryAutoTrade === "function"){
        global.tryAutoTrade(eng, sub, direction, zone, null, "DIGIT_INTEL", Date.now(), "DIGIT_INTEL");
      }
      var st2 = document.getElementById("zonaDIBridgeStatus");
      if(st2) st2.textContent = "AutoTrader signal submitted: " + sig.strategy + " · " + sig.contract_type;
    }catch(ex){
      pushEvent(ensureSymbol(sig.symbol), "Signal rejected", String(ex && ex.message || ex));
    }
  }

  function processObservation(sym, quote, epoch, digit){
    var ss = ensureSymbol(sym);
    ss.seq += 1;
    ss.observations.push({ symbol: sym, quote: quote, digit: digit, epoch: epoch, seq: ss.seq });
    if(ss.observations.length > MAX_HISTORY) ss.observations = ss.observations.slice(-MAX_HISTORY);
    ss.lastQuote = quote; ss.lastDigit = digit; ss.lastEpoch = epoch;
    if(state.paused) return;
    if(state.enableDiffers) updateDiffers(sym, ss, digit);
    if(state.enableEvenOdd) updateEvenOdd(sym, ss, digit);
    if(state.enableOverUnder) updateOverUnder(sym, ss, digit);
  }

  function updateDiffers(sym, ss, digit){
    var obs = ss.observations;
    var w100 = windowStats(obs, 100), w500 = windowStats(obs, 500), w1000 = windowStats(obs, 1000);
    var d = ss.differs;
    if(!w100.complete || !w500.complete || !w1000.complete){ d.state = "Collecting Data"; d.candidate = null; return; }
    var l100 = uniqueLowestDigit(w100), l500 = uniqueLowestDigit(w500), l1000 = uniqueLowestDigit(w1000);
    var valid = l100.unique && l500.unique && l1000.unique && l100.digit === l500.digit && l500.digit === l1000.digit;
    if(!valid){
      if(d.candidate !== null){
        pushEvent(ss, "Candidate invalidated", "Windows no longer agree on unique lowest digit");
        d.candidate = null; d.nextExpected = 0; d.sequenceProgress = []; d.state = "No Candidate";
      } else { d.state = "No Candidate"; }
      return;
    }
    var cand = l100.digit;
    if(d.candidate !== cand){
      pushEvent(ss, d.candidate === null ? "Candidate established" : "Candidate changed", (d.candidate===null?"DIFFERS target ":(d.candidate+" → ")) + cand);
      d.candidate = cand; d.nextExpected = 0; d.sequenceProgress = []; d.state = "Valid Candidate";
    }
    if(d.candidate === null) return;
    d.state = "Waiting for Trigger";
    var expected = d.nextExpected;
    if(expected === d.candidate){ expected = (expected + 1) % 10; d.nextExpected = expected; }
    if(digit === expected){
      var sig = { id: uid(), strategy: "DIFFERS", symbol: sym, direction: "BUY", contract_type: "DIGITDIFF", barrier: String(d.candidate), digit: digit, ts: Date.now() };
      d.state = "Entry Signal Generated";
      pushEvent(ss, "DIFFERS trigger", "Observed " + digit + " → DIFFERS " + d.candidate);
      var next = (expected + 1) % 10;
      if(next === d.candidate) next = (next + 1) % 10;
      d.nextExpected = next;
      d.sequenceProgress.push(digit);
      emitSignal(sig);
    }
  }

  function updateEvenOdd(sym, ss, digit){
    var eo = ss.evenOdd;
    var targetEven = state.eoTarget === "EVEN";
    var isTarget = targetEven ? isEven(digit) : !isEven(digit);
    if(isTarget){ eo.streak = 0; eo.lastOppositeDigit = null; eo.consumed = false; eo.state = "Waiting for Trigger"; return; }
    if(eo.lastOppositeDigit === digit){ /* identical consecutive counts once */ }
    else { eo.streak += 1; eo.lastOppositeDigit = digit; }
    eo.state = "Waiting for Trigger";
    if(eo.streak >= state.eoCount){
      if(state.eoMode === "SINGLE" && eo.consumed) return;
      var sig = { id: uid(), strategy: "EVEN_ODD", symbol: sym, direction: targetEven ? "BUY" : "SELL", contract_type: targetEven ? "DIGITEVEN" : "DIGITODD", barrier: null, digit: digit, ts: Date.now() };
      eo.state = "Entry Signal Generated";
      if(state.eoMode === "SINGLE") eo.consumed = true;
      eo.streak = 0;
      eo.lastOppositeDigit = state.eoMode === "CONTINUOUS" ? digit : null;
      pushEvent(ss, "EVEN/ODD signal", state.eoTarget + " after " + state.eoCount + " opposite");
      emitSignal(sig);
    }
  }

  function updateOverUnder(sym, ss, digit){
    var ou = ss.overUnder;
    var th = state.ouThreshold|0;
    var targetOver = state.ouTarget === "OVER";
    var isTarget = targetOver ? isOver(digit, th) : isUnder(digit, th);
    if(isTarget){ ou.streak = 0; ou.lastOppositeDigit = null; ou.consumed = false; ou.state = "Waiting for Trigger"; return; }
    if(ou.lastOppositeDigit === digit){}
    else { ou.streak += 1; ou.lastOppositeDigit = digit; }
    ou.state = "Waiting for Trigger";
    if(ou.streak >= state.ouCount){
      if(state.ouMode === "SINGLE" && ou.consumed) return;
      var ct = targetOver ? "DIGITOVER" : "DIGITUNDER";
      var sig = { id: uid(), strategy: "OVER_UNDER", symbol: sym, direction: targetOver ? "BUY" : "SELL", contract_type: ct, barrier: String(th), digit: digit, ts: Date.now() };
      ou.state = "Entry Signal Generated";
      if(state.ouMode === "SINGLE") ou.consumed = true;
      ou.streak = 0;
      ou.lastOppositeDigit = state.ouMode === "CONTINUOUS" ? digit : null;
      pushEvent(ss, "OVER/UNDER signal", state.ouTarget + " th="+th+" after "+state.ouCount+" opposite");
      emitSignal(sig);
    }
  }

  function onTick(payload){
    if(!payload) return;
    var sym = payload.symbol || state.symbol;
    if(sym !== state.symbol) return;
    var quote = payload.quote, epoch = payload.epoch;
    var digit = extractFinalDigit((payload.raw && payload.raw.quote !== undefined) ? payload.raw.quote : quote);
    if(digit === null){
      pushEvent(ensureSymbol(sym), "Observation rejected", "Could not extract final digit from quote "+quote);
      return;
    }
    processObservation(sym, quote, epoch, digit);
    renderUI();
  }

  function getPendingContract(){ return state.pendingContract; }

  function manualTrade(){
    var family = (document.getElementById("di_manualFamily") || {}).value || "DIFFERS";
    var barrierEl = document.getElementById("di_manualBarrier");
    var barrier = barrierEl ? String(barrierEl.value) : "5";
    var log = document.getElementById("di_manualLog");
    var ctMap = { DIFFERS:"DIGITDIFF", MATCHES:"DIGITMATCH", EVEN:"DIGITEVEN", ODD:"DIGITODD", OVER:"DIGITOVER", UNDER:"DIGITUNDER" };
    var ct = ctMap[family] || "DIGITDIFF";
    var needsBarrier = (ct === "DIGITDIFF" || ct === "DIGITMATCH" || ct === "DIGITOVER" || ct === "DIGITUNDER");
    var direction = (family === "ODD" || family === "UNDER") ? "SELL" : "BUY";
    var eng = { symbol: state.symbol, name: state.symbol, active: true, PA: {}, TT: {} };
    try{ if(typeof engines !== "undefined" && engines[state.symbol]) eng = engines[state.symbol]; }catch(e){}
    state.pendingContract = { contract_type: ct, barrier: needsBarrier ? barrier : null, direction: direction, symbol: state.symbol, signalId: uid(), strategy: "MANUAL_DIGIT" };
    var zone = { _digitContract: { contract_type: ct, barrier: needsBarrier ? barrier : null } };
    if(log) log.textContent = "Requesting proposal: " + ct + (needsBarrier ? " barrier="+barrier : "") + " on " + state.symbol;
    try{
      if(typeof requestProposal === "function") requestProposal(eng, direction, zone, null, "DIGIT_INTEL", "DIGIT_INTEL");
      else if(typeof global.requestProposal === "function") global.requestProposal(eng, direction, zone, null, "DIGIT_INTEL", "DIGIT_INTEL");
      else if(log) log.textContent = "Trade engine requestProposal not available.";
    }catch(ex){ if(log) log.textContent = "Error: " + (ex && ex.message || ex); }
  }

  function el(id){ return document.getElementById(id); }

  function renderWindows(ss){
    var body = el("di_windowsBody"); if(!body) return;
    var obs = ss.observations;
    body.innerHTML = WINDOW_SIZES.map(function(sz){
      var st = windowStats(obs, sz);
      var cells = st.counts.map(function(c,i){ return "<td style='text-align:center;padding:3px;'>"+c+"<br><span style='color:var(--muted);font-size:9px'>"+st.pct[i].toFixed(1)+"%</span></td>"; }).join("");
      var status = st.complete ? "<span style='color:var(--green)'>Complete</span>" : "<span style='color:var(--yellow)'>Incomplete</span>";
      return "<tr><td style='padding:3px;font-weight:700;'>"+sz+"</td>"+cells+"<td style='text-align:center'>"+st.count+"</td><td style='text-align:center'>"+status+"</td></tr>";
    }).join("");
  }

  function renderDiffers(ss){
    var d = ss.differs;
    if(el("di_differsCandidate")) el("di_differsCandidate").textContent = d.candidate === null ? "—" : String(d.candidate);
    if(el("di_differsNext")) el("di_differsNext").textContent = d.candidate === null ? "—" : String(d.nextExpected);
    if(el("di_differsSeq")) el("di_differsSeq").textContent = d.sequenceProgress.length ? d.sequenceProgress.join(" → ") : "—";
    if(el("di_differsState")) el("di_differsState").textContent = d.state || "—";
    if(el("di_differsInfo")){
      el("di_differsInfo").textContent = WINDOW_SIZES.map(function(sz){
        var w = windowStats(ss.observations, sz); var u = uniqueLowestDigit(w);
        return sz+": " + (w.complete ? (u.unique ? ("lowest "+u.digit) : ("tie ["+u.tied.join(",")+"]")) : ("n="+w.count));
      }).join(" · ");
    }
  }

  function renderEvenOdd(ss){
    if(el("di_eoStreak")) el("di_eoStreak").textContent = String(ss.evenOdd.streak);
    if(el("di_eoState")) el("di_eoState").textContent = ss.evenOdd.state;
    if(el("di_eoStats")){
      el("di_eoStats").textContent = WINDOW_SIZES.map(function(sz){
        var w = windowStats(ss.observations, sz); var even=0,odd=0;
        for(var i=0;i<=9;i++){ if(isEven(i)) even+=w.counts[i]; else odd+=w.counts[i]; }
        var n=w.count||1;
        return sz+": EVEN "+even+" ("+((even/n)*100).toFixed(1)+"%) · ODD "+odd+" ("+((odd/n)*100).toFixed(1)+"%)"+(w.complete?"":" [incomplete]");
      }).join(" | ");
    }
  }

  function renderOverUnder(ss){
    var th = state.ouThreshold|0;
    if(el("di_ouStreak")) el("di_ouStreak").textContent = String(ss.overUnder.streak);
    if(el("di_ouState")) el("di_ouState").textContent = ss.overUnder.state;
    if(el("di_ouStats")){
      el("di_ouStats").textContent = WINDOW_SIZES.map(function(sz){
        var w = windowStats(ss.observations, sz); var over=0,under=0;
        for(var i=0;i<=9;i++){ if(isOver(i,th)) over+=w.counts[i]; else under+=w.counts[i]; }
        var n=w.count||1;
        return sz+": OVER "+over+" ("+((over/n)*100).toFixed(1)+"%) · UNDER "+under+" ("+((under/n)*100).toFixed(1)+"%)"+(w.complete?"":" [incomplete]");
      }).join(" | ");
    }
  }

  function renderMatchesDiffers(ss){
    if(!el("di_mdStats")) return;
    var digit = state.mdDigit|0;
    el("di_mdStats").textContent = WINDOW_SIZES.map(function(sz){
      var w = windowStats(ss.observations, sz);
      var m = w.counts[digit]||0, n = w.count||0, d = n-m;
      return sz+": MATCHES "+m+" ("+(n?(m/n)*100:0).toFixed(1)+"%) · DIFFERS "+d+" ("+(n?(d/n)*100:0).toFixed(1)+"%)"+(w.complete?"":" [incomplete]");
    }).join(" | ");
  }

  function renderEvents(ss){
    var box = el("di_eventLog"); if(!box) return;
    box.innerHTML = (ss.events||[]).slice(0,30).map(function(e){
      return "<div>["+new Date(e.t).toLocaleTimeString()+"] <b>"+e.type+"</b> — "+(e.detail||"")+"</div>";
    }).join("") || "<div>No events yet</div>";
  }

  function renderUI(){
    var ss = ensureSymbol(state.symbol);
    if(el("di_quote")) el("di_quote").textContent = ss.lastQuote!=null ? String(ss.lastQuote) : "—";
    if(el("di_digit")) el("di_digit").textContent = ss.lastDigit!=null ? String(ss.lastDigit) : "—";
    if(el("di_obsCount")) el("di_obsCount").textContent = String(ss.observations.length);
    if(el("di_status")) el("di_status").textContent = state.paused ? "Paused" : (ss.observations.length ? "Live" : "Waiting for ticks…");
    renderWindows(ss); renderDiffers(ss); renderEvenOdd(ss); renderOverUnder(ss); renderMatchesDiffers(ss); renderEvents(ss);
    if(el("di_latestSignal")){
      if(state.lastSignal){ var s=state.lastSignal; el("di_latestSignal").textContent = s.strategy+" · "+s.contract_type+(s.barrier!=null?" · barrier "+s.barrier:"")+" · "+s.symbol+" · id "+s.id; }
      else el("di_latestSignal").textContent = "None yet";
    }
    var chip = el("zonaDITradeChip");
    if(chip){
      var any = state.enableDiffers || state.enableEvenOdd || state.enableOverUnder;
      chip.textContent = state.paused ? "PAUSED" : (any ? "ACTIVE" : "OFF");
      chip.className = "trade-status-chip " + (state.paused ? "chip-off" : (any ? "chip-on" : "chip-off"));
    }
  }

  function bindUI(){
    var toggle = el("zonaDITradeToggle"), card = el("zonaDITradeCard");
    if(toggle && card){
      toggle.addEventListener("click", function(){
        card.classList.toggle("collapsed");
        var ch = el("zonaDIChevron");
        if(ch) ch.textContent = card.classList.contains("collapsed") ? "▶" : "▼";
      });
    }
    function bindChange(id, fn){ var node = el(id); if(node) node.addEventListener("change", fn); }
    bindChange("di_symbol", function(){ state.symbol = el("di_symbol").value; ensureSymbol(state.symbol); saveSettings(); renderUI(); });
    bindChange("di_enableDiffers", function(){ state.enableDiffers = !!el("di_enableDiffers").checked; saveSettings(); });
    bindChange("di_enableEvenOdd", function(){ state.enableEvenOdd = !!el("di_enableEvenOdd").checked; saveSettings(); });
    bindChange("di_enableOverUnder", function(){ state.enableOverUnder = !!el("di_enableOverUnder").checked; saveSettings(); });
    bindChange("di_paused", function(){ state.paused = !!el("di_paused").checked; saveSettings(); renderUI(); });
    bindChange("di_eoTarget", function(){ state.eoTarget = el("di_eoTarget").value; ensureSymbol(state.symbol).evenOdd.streak=0; saveSettings(); });
    bindChange("di_eoCount", function(){ state.eoCount = Math.max(1, Math.min(20, parseInt(el("di_eoCount").value,10)||3)); saveSettings(); });
    bindChange("di_eoMode", function(){ state.eoMode = el("di_eoMode").value; ensureSymbol(state.symbol).evenOdd.consumed=false; saveSettings(); });
    bindChange("di_ouThreshold", function(){ state.ouThreshold = Math.max(0, Math.min(9, parseInt(el("di_ouThreshold").value,10)||5)); ensureSymbol(state.symbol).overUnder.streak=0; saveSettings(); renderUI(); });
    bindChange("di_ouTarget", function(){ state.ouTarget = el("di_ouTarget").value; ensureSymbol(state.symbol).overUnder.streak=0; saveSettings(); });
    bindChange("di_ouCount", function(){ state.ouCount = Math.max(1, Math.min(20, parseInt(el("di_ouCount").value,10)||3)); saveSettings(); });
    bindChange("di_ouMode", function(){ state.ouMode = el("di_ouMode").value; ensureSymbol(state.symbol).overUnder.consumed=false; saveSettings(); });
    bindChange("di_mdDigit", function(){ state.mdDigit = Math.max(0, Math.min(9, parseInt(el("di_mdDigit").value,10)||0)); saveSettings(); renderUI(); });
    var buyBtn = el("di_manualBuy"); if(buyBtn) buyBtn.addEventListener("click", function(){ manualTrade(); });
    try{
      if(el("di_symbol")) el("di_symbol").value = state.symbol;
      if(el("di_enableDiffers")) el("di_enableDiffers").checked = !!state.enableDiffers;
      if(el("di_enableEvenOdd")) el("di_enableEvenOdd").checked = !!state.enableEvenOdd;
      if(el("di_enableOverUnder")) el("di_enableOverUnder").checked = !!state.enableOverUnder;
      if(el("di_paused")) el("di_paused").checked = !!state.paused;
      if(el("di_eoTarget")) el("di_eoTarget").value = state.eoTarget;
      if(el("di_eoCount")) el("di_eoCount").value = state.eoCount;
      if(el("di_eoMode")) el("di_eoMode").value = state.eoMode;
      if(el("di_ouThreshold")) el("di_ouThreshold").value = state.ouThreshold;
      if(el("di_ouTarget")) el("di_ouTarget").value = state.ouTarget;
      if(el("di_ouCount")) el("di_ouCount").value = state.ouCount;
      if(el("di_ouMode")) el("di_ouMode").value = state.ouMode;
      if(el("di_mdDigit")) el("di_mdDigit").value = String(state.mdDigit);
    }catch(e){}
  }

  function init(){ loadSettings(); ensureSymbol(state.symbol); bindUI(); renderUI(); }

  global.ZonaDigitIntel = {
    onTick: onTick,
    getPendingContract: getPendingContract,
    getState: function(){ return state; },
    extractFinalDigit: extractFinalDigit,
    init: init
  };

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 0);
  }
})(window);
