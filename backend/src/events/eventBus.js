const EventEmitter = require('events');
const { query } = require('../db/pool');

/**
 * Bus de Eventos de Dominio (INT2 - equivalente a los 11 tópicos Apache Kafka del diagrama C4 N2):
 * - usuarios.registrados
 * - matriculas.confirmadas
 * - aforo.alerta
 * - asistencias.registradas
 * - membresias.vencidas
 * - stock.combo.descontar
 * - stock.reorden.alerta
 * - pagos.conciliados
 * - comprobantes.emitidos
 * - seguridad.incidente.log
 * - crm.leads.capturados
 */
class DomainEventBus extends EventEmitter {
  async publish(topico, payload, origen = 'CORE') {
    const evento = {
      topico,
      payload,
      origen,
      timestamp: new Date().toISOString(),
    };

    try {
      await query(
        'INSERT INTO eventos_dominio (topico, payload, origen) VALUES ($1, $2::jsonb, $3)',
        [topico, JSON.stringify(payload || {}), origen]
      );
    } catch (err) {
      // No interrumpir transacción principal si falla el log de evento
      console.error(`[EventBus] Error persistiendo evento ${topico}:`, err.message);
    }

    this.emit(topico, evento);
    this.emit('*', evento);
    return evento;
  }
}

const eventBus = new DomainEventBus();

module.exports = {
  eventBus,
  TOPICOS: {
    USUARIOS_REGISTRADOS: 'usuarios.registrados',
    MATRICULAS_CONFIRMADAS: 'matriculas.confirmadas',
    AFORO_ALERTA: 'aforo.alerta',
    ASISTENCIAS_REGISTRADAS: 'asistencias.registradas',
    MEMBRESIAS_VENCIDAS: 'membresias.vencidas',
    STOCK_COMBO_DESCONTAR: 'stock.combo.descontar',
    STOCK_REORDEN_ALERTA: 'stock.reorden.alerta',
    PAGOS_CONCILIADOS: 'pagos.conciliados',
    COMPROBANTES_EMITIDOS: 'comprobantes.emitidos',
    SEGURIDAD_INCIDENTE_LOG: 'seguridad.incidente.log',
    CRM_LEADS_CAPTURADOS: 'crm.leads.capturados',
  },
};

