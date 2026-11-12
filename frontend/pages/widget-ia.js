/**
 * widget-ia.js — APU5: Web Chat Asistente IA 24/7 + MCP Client + Lead Capture
 */
(function () {
  if (document.getElementById('ff-ia-root')) return;

  var apiBase = typeof getApiBase === 'function' ? getApiBase() : '';
  var sessionKey = localStorage.getItem('ff_ia_session') || 'ses-' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem('ff_ia_session', sessionKey);

  var style = document.createElement('style');
  style.textContent = `
    #ff-ia-fab{position:fixed;bottom:22px;right:22px;z-index:9999;background:linear-gradient(135deg,#0d2d5e,#1e40af);color:#fff;border:none;border-radius:999px;padding:13px 18px;font-family:Inter,sans-serif;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(13,45,94,.35);display:flex;align-items:center;gap:8px;}
    #ff-ia-fab:hover{transform:translateY(-2px);}
    #ff-ia-panel{position:fixed;bottom:80px;right:22px;width:390px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 105px);background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.22);z-index:9999;display:none;flex-direction:column;overflow:hidden;font-family:Inter,sans-serif;}
    #ff-ia-panel.open{display:flex;}
    .ff-ia-hdr{background:linear-gradient(135deg,#0d2d5e,#1e40af);color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;}
    .ff-ia-hdr h4{font-size:14px;font-weight:800;margin:0;}
    .ff-ia-hdr small{font-size:11px;opacity:.85;}
    .ff-ia-close{background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:8px;width:28px;height:28px;cursor:pointer;font-weight:700;}
    .ff-ia-chips{padding:8px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;display:flex;gap:6px;overflow-x:auto;}
    .ff-ia-chip{background:#fff;border:1px solid #cbd5e1;color:#0d2d5e;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;}
    .ff-ia-chip:hover{background:#eff6ff;border-color:#0d2d5e;}
    .ff-ia-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f8fafc;}
    .ff-msg{max-width:88%;padding:10px 12px;border-radius:12px;font-size:12.5px;line-height:1.45;white-space:pre-line;}
    .ff-msg.bot{background:#fff;border:1px solid #e5e7eb;color:#1f2937;align-self:flex-start;}
    .ff-msg.user{background:#0d2d5e;color:#fff;align-self:flex-end;}
    .ff-mcp-card{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px;font-size:11.5px;margin-top:4px;}
    .ff-mcp-slot{display:flex;justify-content:space-between;align-items:center;background:#fff;border:1px solid #dbeafe;border-radius:8px;padding:7px 9px;margin-top:6px;}
    .ff-mcp-btn{background:#0d2d5e;color:#fff;border:none;border-radius:6px;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer;}
    .ff-lead-box{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:7px;}
    .ff-lead-box input,.ff-lead-box select{border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:12px;font-family:inherit;}
    .ff-ia-foot{padding:10px;border-top:1px solid #e5e7eb;background:#fff;display:flex;gap:8px;}
    .ff-ia-foot input{flex:1;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 11px;font-size:13px;outline:none;}
    .ff-ia-foot input:focus{border-color:#0d2d5e;}
    .ff-ia-foot button{background:#0d2d5e;color:#fff;border:none;border-radius:8px;padding:0 14px;font-weight:700;font-size:12px;cursor:pointer;}
  `;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.id = 'ff-ia-root';
  root.innerHTML = `
    <button id="ff-ia-fab">🤖 Asistente IA 24/7</button>
    <div id="ff-ia-panel">
      <div class="ff-ia-hdr">
        <div>
          <h4>Asistente Forca &amp; Fitness IA</h4>
          <small>RAG + MCP en vivo (Aforos 18/tatami y Combos)</small>
        </div>
        <button class="ff-ia-close" id="ff-ia-close">✕</button>
      </div>
      <div class="ff-ia-chips">
        <button class="ff-ia-chip" data-q="¿Qué horarios de BJJ hay en Surco?">🥋 Horarios BJJ Surco</button>
        <button class="ff-ia-chip" data-q="¿Cuánto cuestan los planes y el Combo AFF?">💳 Precios y Combo AFF</button>
        <button class="ff-ia-chip" data-q="¿Tienen stock de Kimono talla A2?">🎒 Stock Kimono A2</button>
        <button class="ff-ia-chip" id="ff-ia-lead-btn">📞 Quiero que me contacten</button>
      </div>
      <div class="ff-ia-body" id="ff-ia-msgs">
        <div class="ff-msg bot">¡Hola! Soy el Asistente IA 24/7 de Forca &amp; Fitness. Consulto cupos reales (máx. 18 por tatami) y tallas AFF Gear vía protocolo MCP. ¿En qué sede deseas entrenar: Surco, La Molina o San Borja?</div>
      </div>
      <div class="ff-ia-foot">
        <input type="text" id="ff-ia-input" placeholder="Pregunta sobre horarios, precios, tallas..."/>
        <button id="ff-ia-send">Enviar</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  var fab = document.getElementById('ff-ia-fab');
  var panel = document.getElementById('ff-ia-panel');
  var closeBtn = document.getElementById('ff-ia-close');
  var msgs = document.getElementById('ff-ia-msgs');
  var input = document.getElementById('ff-ia-input');
  var sendBtn = document.getElementById('ff-ia-send');

  fab.onclick = function () { panel.classList.toggle('open'); };
  closeBtn.onclick = function () { panel.classList.remove('open'); };

  function appendMsg(role, text) {
    var div = document.createElement('div');
    div.className = 'ff-msg ' + role;
    div.textContent = text.replace(/\*\*/g, '');
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  async function sendQuestion(qText) {
    var q = (qText || input.value).trim();
    if (!q) return;
    if (!qText) input.value = '';
    appendMsg('user', q);

    try {
      var token = localStorage.getItem('token') || '';
      var res = await fetch(apiBase + '/api/ia/chat', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: JSON.stringify({ message: q, session_key: sessionKey }),
      });
      var data = await res.json();
      appendMsg('bot', data.reply || 'No pude procesar tu consulta.');

      // Tarjeta interactiva SelectorVacantesMcpWidget
      if (data.horarios_mcp && data.horarios_mcp.length) {
        var card = document.createElement('div');
        card.className = 'ff-mcp-card';
        card.innerHTML = '<strong>⚡ Vacantes en vivo (MCP consultar_aforo):</strong>';
        data.horarios_mcp.slice(0, 3).forEach(function (h) {
          var row = document.createElement('div');
          row.className = 'ff-mcp-slot';
          row.innerHTML =
            '<div><strong>' + h.titulo + '</strong><br><span style="color:#64748b">' + h.sede_nombre + ' · ' + h.hora_inicio + ' (' + h.disponibles + '/18 libres)</span></div>' +
            '<button class="ff-mcp-btn">Reservar</button>';
          row.querySelector('button').onclick = function () {
            reservarDesdeChat(h.id, h.disciplina);
          };
          card.appendChild(row);
        });
        msgs.appendChild(card);
      }

      // Tarjeta RecomendadorComboAffCard
      if (data.recomendacion_combo) {
        var cCard = document.createElement('div');
        cCard.className = 'ff-mcp-card';
        cCard.innerHTML =
          '<strong>🥋 ' + data.recomendacion_combo.titulo + '</strong><br>' +
          '<span style="color:#334155">' + data.recomendacion_combo.incluye + '</span><br>' +
          '<button class="ff-mcp-btn" style="margin-top:6px;">Ir a contratar Combo AFF →</button>';
        cCard.querySelector('button').onclick = function () {
          location.href = data.recomendacion_combo.deeplink;
        };
        msgs.appendChild(cCard);
      }

      msgs.scrollTop = msgs.scrollHeight;
    } catch (e) {
      appendMsg('bot', 'Error conectando con el Agente IA.');
    }
  }

  async function reservarDesdeChat(horarioId, disciplina) {
    var token = localStorage.getItem('token');
    if (!token) {
      appendMsg('bot', 'Te redirijo para iniciar sesión o elegir tu plan en ' + disciplina + ' y confirmar tu cupo.');
      setTimeout(function () {
        location.href = '/pages/portal/renovar.html?plan=COMBO_AFF';
      }, 900);
      return;
    }
    try {
      var res = await fetch(apiBase + '/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'reservar_cupo', arguments: { horario_id: horarioId } } }),
      });
      var out = await res.json();
      var r = out.result || {};
      if (r.confirmada) {
        appendMsg('bot', '✅ ¡Cupo confirmado vía MCP para ' + r.horario.titulo + '!');
      } else if (r.requiere_pago) {
        appendMsg('bot', 'Tu matrícula requiere renovación activa. Te llevo a Planes y Combo AFF.');
        setTimeout(function () { location.href = '/pages/portal/renovar.html'; }, 1000);
      } else if (r.ya_reservado) {
        appendMsg('bot', 'ℹ Ya tienes una reserva confirmada en este turno.');
      } else {
        appendMsg('bot', r.error || 'No se pudo completar la reserva.');
      }
    } catch (e) {
      appendMsg('bot', 'Error ejecutando tool MCP reservar_cupo.');
    }
  }

  function showLeadForm() {
    var box = document.createElement('div');
    box.className = 'ff-lead-box';
    box.innerHTML = `
      <strong style="font-size:12px;color:#0d2d5e;">📞 Captura de Prospecto 24/7</strong>
      <input type="text" id="leadNombre" placeholder="Tu nombre completo"/>
      <input type="text" id="leadWsp" placeholder="WhatsApp (ej. 999888777)"/>
      <select id="leadSede"><option>Sede Surco</option><option>Sede La Molina</option><option>Sede San Borja</option></select>
      <select id="leadDisc"><option>Brazilian Jiu-Jitsu</option><option>Muay Thai</option><option>Boxeo</option><option>Capoeira</option><option>Acondicionamiento</option></select>
      <button class="ff-mcp-btn" id="leadSendBtn" style="padding:7px;">Enviar mis datos</button>
    `;
    msgs.appendChild(box);
    msgs.scrollTop = msgs.scrollHeight;
    box.querySelector('#leadSendBtn').onclick = async function () {
      var nombre = box.querySelector('#leadNombre').value.trim();
      var whatsapp = box.querySelector('#leadWsp').value.trim();
      var sede_interes = box.querySelector('#leadSede').value;
      var disciplina_interes = box.querySelector('#leadDisc').value;
      if (!nombre || !whatsapp) return alert('Completa tu nombre y WhatsApp.');
      var r = await fetch(apiBase + '/api/ia/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, whatsapp, sede_interes, disciplina_interes }),
      });
      var d = await r.json();
      box.remove();
      appendMsg('bot', d.message || '¡Datos guardados en CRM!');
    };
  }

  document.querySelectorAll('.ff-ia-chip[data-q]').forEach(function (btn) {
    btn.onclick = function () { sendQuestion(btn.getAttribute('data-q')); };
  });
  document.getElementById('ff-ia-lead-btn').onclick = showLeadForm;
  sendBtn.onclick = function () { sendQuestion(); };
  input.onkeydown = function (e) { if (e.key === 'Enter') sendQuestion(); };
})();

