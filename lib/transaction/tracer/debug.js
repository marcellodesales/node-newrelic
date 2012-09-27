'use strict';

var path  = require('path')
  , util  = require('util')
  , State = require(path.join(__dirname, 'state'))
  ;

/**
 *
 *
 * THE MODEL:
 *
 * A simple set of classes intended to model a call chain within the scope of
 * a New Relic transaction trace. The players are transactions (e.g. web page
 * requests), trace segments for subsidiary calls (e.g. database or memcached
 * calls), and instrumented callbacks.
 *
 * The goal is to be able to model the scenarios outlined in the test cases,
 * copied up here for easy reference:
 *
 * a. direct function execution
 * b. an asynchronous function -- that is, a function that returns a callback,
 *    that can be executed at an arbitrary future time
 * c. two overlapping executions of an asynchronous function and its callback
 * d. direct function execution, including direct execution of an instrumented
 *    subsidiary function
 * e. an asynchronous function that calls an asynchronous subsidiary function
 * f. two overlapping executions of an asynchronous function with an
 *    asynchronous subsidiary function
 *
 * Here are some of the rules the model is intended to follow:
 *
 * 1. Every call, segment, and transaction has an ID (for the purposes of these
 *    tests, that ID is derived from how many of each thing are associated
 *    with a given trace).
 * 2. Every Call is associated with a Segment.
 * 3. Every Segment is associated with a Trace.
 *
 *
 */

/**
 * CALL
 */
function Call(id, segment, value) {
  if (!id) throw new Error("Calls must have an ID.");
  if (!segment) throw new Error("Calls must be associated with a segment.");
  if (!value) throw new Error("Calls must be associated with a segment value.");

  this.id      = id;
  this.segment = segment;
  this.value   = value;
}

Call.prototype.format = function () {
  return util.format("T%dS%dC%d",
                     this.segment.transaction.id,
                     this.segment.id,
                     this.id);
};


/**
 * SEGMENT
 */
function Segment(id, transaction, value) {
  if (!id) throw new Error("Segments must have an ID.");
  if (!transaction) throw new Error("Segments must be associated with a transaction.");
  if (!value) throw new Error("Segments must be associated with a value.");

  this.id          = id;
  this.transaction = transaction;
  this.value       = value;

  this.numCalls = 0;
}

Segment.prototype.addCall = function (value) {
  this.numCalls += 1;
  return new Call(this.numCalls, this, value);
};


/**
 * TRANSACTION
 */
function Transaction (id, value) {
  if (!id) throw new Error("Transactions must have an ID.");
  if (!value) throw new Error("Transactions must be associated with a value.");

  this.id    = id;
  this.value = value;

  this.numSegments = 0;
}

Transaction.prototype.addSegment = function (value) {
  this.numSegments += 1;
  return new Segment(this.numSegments, this, value);
};

function Describer() {
  this.trace     = [];
  this.creations = [];
  this.wrappings = [];

  this.verbose   = [];
}

Describer.prototype.traceCall = function (direction, call) {
  var id = direction + call.format();

  this.trace.push(id);
  this.verbose.push(id);
};

Describer.prototype.traceCreation = function (type) {
  var creation = util.format("+%s", type[0]);

  this.creations.push(creation);
  this.verbose.push(creation);
};

Describer.prototype.traceWrapping = function (direction, type) {
  var wrapping = util.format("%s%s", direction, type);

  this.wrappings.push(wrapping);
  this.verbose.push(wrapping);
};

Describer.prototype.wrapExecution = function (type, handler) {
  var self = this;
  return function () {
    self.traceWrapping('->', type);
    var returned = handler.apply(this, arguments);
    self.traceWrapping('<-', type);

    return returned;
  };
};

/**
 * EXECUTION TRACER
 *
 * One instance of this class exists per transaction, with the state
 * representing the current context shared between multiple instances.
 *
 * The transaction tracer works by wrapping either the generator functions
 * that asynchronously handle incoming requests (via
 * Tracer.transactionProxy and Tracer.segmentProxy) or direct function
 * calls in the form of callbacks (via Tracer.callbackProxy).
 *
 * In both cases, the wrappers exist to set up the execution context for
 * the wrapped functions. The context is effectively global, and works in
 * a manner similar to Node 0.8's domains, by explicitly setting up and
 * tearing down the current transaction / segment / call around each
 * wrapped function's invocation. It relies upon the fact that Node is
 * single-threaded, and requires that each entry and exit be paired
 * appropriately so that the context is left in its proper state.
 *
 * This version is optimized for debugging. A new version should be made
 * for production use without all of the internal tracing information
 * included.
 */
function Tracer(agent, context) {
  if (!agent) throw new Error("Must be initialized with an agent.");
  if (!context) throw new Error("Must include shared context.");

  this.numTransactions = 0;
  this.agent           = agent;
  this.context         = context;
  this.describer       = new Describer();
}

Tracer.prototype.enter = function (state) {
  this.describer.traceCall('->', state.call);
  this.context.enter(state);
};

Tracer.prototype.exit = function (state) {
  this.describer.traceCall('<-', state.call);
  this.context.exit(state);
};

Tracer.prototype.addTransaction = function (value) {
  this.numTransactions += 1;

  this.describer.traceCreation('Trace');
  return new Transaction(this.numTransactions, value);
};

Tracer.prototype.addSegment = function (transaction, value) {
  this.describer.traceCreation('Segment');
  return transaction.addSegment(value);
};

Tracer.prototype.addCall = function (segment, value) {
  this.describer.traceCreation('Call');
  return segment.addCall(value);
};

/**
 * Use transactionProxy to wrap a closure that is a top-level handler that is
 * meant to originate transactions. This is meant to wrap the first half of
 * async calls, not their callbacks.
 *
 * @param {Function} handler Generator to be proxied.
 * @returns {Function} Proxied function.
 */
Tracer.prototype.transactionProxy = function (handler) {
  var self = this;
  return this.describer.wrapExecution('T outer', function () {
    return self.describer.wrapExecution('T inner', function () {
      var value       = self.agent.createTransaction()
        , transaction = self.addTransaction(value)
        , segment     = self.addSegment(transaction, value.getTrace().root)
        , call        = self.addCall(segment, handler)
        ;

      var state = new State(transaction, segment, call, true);
      self.enter(state);
      var returned = handler.apply(this, arguments);
      self.exit(state);

      return returned;
    });
  })(); // <-- call immediately
};

/**
 * Use segmentProxy to wrap a closure that is a top-level handler that is
 * meant to participate in an existing transaction. It will add itself as a
 * new subsidiary to the current transaction. This is meant to wrap the first
 * half of async calls, not their callbacks.
 *
 * @param {Function} handler Generator to be proxied.
 * @returns {Function} Proxied function.
 */
Tracer.prototype.segmentProxy = function (handler) {
  var self = this;
  return this.describer.wrapExecution('S outer', function () {
    return self.describer.wrapExecution('S inner', function () {
      // don't implicitly create transactions
      var state = self.context.state;
      if (!state) return handler.apply(this, arguments);

      var segment = self.addSegment(state.transaction, state.segment.value)
        , call    = self.addCall(segment, handler)
        ;

      state = new State(state.transaction, segment, call, true);
      self.enter(state);
      var returned = handler.apply(this, arguments);
      self.exit(state);

      return returned;
    });
  })(); // <-- call immediately
};

/**
 * Use callbackProxy to wrap a closure that may invoke subsidiary functions that
 * want access to the current transaction. When called, it sets up the correct
 * context before invoking the original function (and tears it down afterwards).
 *
 * Proxying of individual calls is only meant to be done within the scope of
 * an existing transaction. It
 *
 * @param {Function} handler Function to be proxied on invocation.
 * @returns {Function} Proxied function.
 */
Tracer.prototype.callbackProxy = function (handler) {
  // don't implicitly create transactions
  var state = this.context.state;
  if (!state) return handler;

  var self = this;
  return this.describer.wrapExecution('C outer', function () {
    var call = self.addCall(state.call.segment, handler);

    return self.describer.wrapExecution('C inner', function () {
      state = new State(state.transaction, state.segment, call, true);
      self.enter(state);
      var returned = handler.apply(this, arguments);
      self.exit(state);

      return returned;
    });
  })(); // <-- call immediately
};

module.exports = Tracer;