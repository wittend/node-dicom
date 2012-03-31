"use strict";

/**
 * ParseBuffer abstraction.
 *
 * o Can read byte-wise from a stream
 * o implicit and explicit grouping
 */

var util = require('util'),
    log4js = require('log4js'),
    log = log4js.getLogger('parsebuffer'),
    verbose = false;

/**
 * ParseBuffer constructor.
 *
 * Takes an optional stream; if given it autoregisters onData/onEnd
 */
function ParseBuffer(stream) {
    // current buffer
    this.currentBuffer = null;
    // read position in current buffer
    this.currentPosition = 0;
    // read position in the stream
    this.streamPosition = 0;
    // additional queued buffers
    this.bufferQueue = [];
    // sum of all queued buffers and current buffer minus current position
    this.bufferedBytes = 0;
    // records of bytes/callback
    this.requestQueue = [];

    // stack of groups
    this.groupStack = [];
    this.groupEnd = null;

    // End of File
    this.eof = false;
    // An error
    this.error = undefined;

    if (stream) {
        this.registerStream(stream);
    }
}

/**
 * Register the parsebuffer for the data/end events.
 */
ParseBuffer.prototype.registerStream = function (stream) {
    stream.on('error', this.onError.bind(this));
    stream.on('data', this.onData.bind(this));
    stream.on('end', this.onEnd.bind(this));
};

/**
 * Callback for stream data events.
 *
 * Use registerStream to register for the events.
 */
ParseBuffer.prototype.onData = function (buffer) {
    log.debug(util.format("ParseBuffer.onData", buffer));

    if (this.currentBuffer) {
        this.bufferQueue.push(buffer);
    } else {
        this.currentBuffer = buffer;
        this.currentPosition = 0;
    }

    this.bufferedBytes += buffer.length;

    this.consumeRequests();
};

/**
 * Callback for stream data events.
 *
 * Use registerStream to register for the events.
 */
ParseBuffer.prototype.onEnd = function () {
    log.debug("ParseBuffer.onEnd");
    this.eof = true;
};

/**
 * Callback for stream or other error events
 */
ParseBuffer.prototype.onError = function (error) {
    log.debug("ParseBuffer.onError", arguments);
    this.error = error;
};

/**
 * request a buffer with bytes length to be sent to callback.
 */
ParseBuffer.prototype.request = function (bytes, callback) {
    this.requestQueue.push({bytes: bytes, callback: callback});
    this.consumeRequests();
};

/**
 * consume as many of the queued requests as possible.
 */
ParseBuffer.prototype.consumeRequests = function () {
    var request, bytes, srcPos, currentBytes, srcEnd, numCopied, dst, dstPos, topGroup;
    while ((request = this.requestQueue.shift()) !== undefined) {
        if (this.bufferedBytes < request.bytes) {
            this.requestQueue.unshift(request);
            break;
        }
        if (verbose) {
            log.trace(util.format("ParseBuffer.consumeRequest: consuming", request));
        }

        // use the current part
        bytes = request.bytes;
        srcPos = this.currentPosition;
        currentBytes = this.currentBuffer.length - srcPos;
        srcEnd = (currentBytes < bytes) ? this.currentBuffer.length : srcPos + bytes;
        numCopied = srcEnd - srcPos;
        dst = new Buffer(bytes);
        dstPos = 0;

        this.currentBuffer.copy(dst, dstPos, srcPos, srcEnd);
        bytes -= numCopied;
        this.bufferedBytes -= numCopied;
        dstPos += numCopied;
        this.currentPosition = srcEnd;
        this.streamPosition += numCopied;
        if (srcEnd === this.currentBuffer.length) {
            this.currentPosition = 0;
            this.currentBuffer = this.bufferQueue.shift();
        }

        while (bytes > 0) {
            currentBytes = this.currentBuffer.length;
            numCopied = (currentBytes < bytes) ? this.currentBuffer.length : bytes;

            this.currentBuffer.copy(dst, dstPos, 0, numCopied);
            bytes -= numCopied;
            this.bufferedBytes -= numCopied;
            dstPos += numCopied;
            this.currentPosition = numCopied;
            this.streamPosition += numCopied;
            if (numCopied === this.currentBuffer.length) {
                this.currentPosition = 0;
                this.currentBuffer = this.bufferQueue.shift();
            }
        }

        // 2 stage implicit group endGroup
        // we have to false the active property *before* calling the last callback
        // (the one for the rawvalue), because that triggers the decodeDicomElement
        // callback, and that triggers the loop check
        topGroup = this.group();
        if (topGroup && this.streamPosition >= this.groupEnd) {
            topGroup.active = false;
        }

        if (verbose) {
            log.trace(util.format("ParseBuffer.consumeRequest: consuming", dst));
        }
        request.callback(dst);

        // now get rid of the group, *after* the request callback
        // this ensures that the group callback is not called before the last element
        // callback - necessary for explicit groups
        if (topGroup && !topGroup.active) {
            this.exitGroup(true);
        }

    }
};


/**
 * Get the current group or undefined
 */
ParseBuffer.prototype.group = function () {
    return this.groupStack[0];
};

/**
 * Enter into a new group.
 *
 * A group may have a predermined length which will make the group auto-exit
 * after all its bytes have been requested.  This is an implicit group.
 * An explicit group does not end without application calling popGroup.
 */
ParseBuffer.prototype.enterGroup = function (length, callback) {
    if (callback === undefined && typeof length === 'function') {
        callback = length;
		length = undefined;
    }
    var end = (length) ? this.streamPosition + length : undefined;
    this.groupStack.push({length: length, end: end, callback: callback, active: true});
    this.groupEnd = end;
    return this.group();
};

/**
 * Exit an (explicit) group, if any.
 *
 * At this point the group callback will be called.  For implicit groups,
 * this will be called internally with the 'force' arg true.  Don't call this
 * with the force flag set.
 */
ParseBuffer.prototype.exitGroup = function (internalDontUse) {
    var group = this.group();
    if ((group && !group.length) || internalDontUse) {
        this.groupStack.shift();
        this.groupEnd = (this.group()) ? this.group().end : undefined;
        if (group) {
            group.callback();
        }
    }
};

exports.ParseBuffer = ParseBuffer;


/**
 * helper to use with ParseBuffer.request
 *
 * it returns a callback function that sets an index in an array and optionally calls
 * an additional callback
 *
 * pb.request(2, setter(arr,0));
 * pb.request(2, setter(arr,1));
 * pb.request(4, setter(arr,2, function () {
 *   // now we can use all those array members ...
 * }));
 */
exports.setter = function (obj, idx, callback) {
    if (callback === undefined && typeof idx === 'function') {
        callback = idx;
		idx = undefined;
    }
    return function (buffer) {
        if (idx === undefined) {
            obj.push(buffer);
        } else {
            obj[idx] = buffer;
        }
        if (callback) {
            callback(obj);
        }
    };
};