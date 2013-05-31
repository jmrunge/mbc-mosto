var config           = require('mbc-common').config.Mosto.HeartBeats,
    util             = require('util'),
    events           = require('events'), 
    Mosto            = require('./models/Mosto'), 
    moment           = require('moment'),
    mvcp_server      = require('./drivers/mvcp/mvcp-driver'), 
    utils            = require('./utils');

function heartbeats(customConfig) {
    //THIS MODULE ASSUMES MELTED ALWAYS HAS THE SAME CLIPS AS MELTED_MEDIAS 
    //AND THAT THEY ARE IN THE SAME ORDER
    defaults = {
        gc_interval: 1000 * 60 * 60,
        sync_interval: 250,
        mvcp_server: "melted"
    };
    this.config = customConfig || config || defaults;
    
    this.melted_medias = Mosto.Playlists.get('melted_medias');
    
    // TODO: Listen to Mosto.Media#change:playing
    this.current_media = false;
    
    this.timers = {
        gc: undefined,
        sy: undefined
    };
    
    this.server = new mvcp_server(this.config.mvcp_server);
}

heartbeats.prototype.startMvcpServer = function(callback) {
    var self = this;
    var result = self.server.initServer();
    result.then(function() {
        console.log("[HEARTBEAT-MVCP] MVCP server started");
        if (callback !== undefined) {
            callback();
        }
    }, function(err) {
        var e = new Error("[HEARTBEAT-MVCP] Error starting MVCP server: " + err + ".\nRetrying in 2 seconds...");
        console.error(e);
        setTimeout(function() {
            self.startMvcpServer(callback);
        }, 2000);
    });
};

heartbeats.prototype.init = function() {
    this.startMvcpServer(this.initTimers);    
};

heartbeats.prototype.initTimers = function() {
    var self = this;
    this.timers.gc = setInterval(function() {
        self.executeGc();
    }, self.config.gc_interval);
    this.timers.sy = setInterval(function() {
        self.syncMelted();
    }, self.config.sync_interval);
};

heartbeats.prototype.clear = function() {
    clearInterval(this.timers.gc);
    clearInterval(this.timers.sy);
};

heartbeats.prototype.executeGc = function() {
    var self = this;
    console.log("[HEARTBEAT-GC] Started Garbage Collector");
    var timeLimit = moment().subtract('hours', 1);
    var oldMedias = self.melted_medias.filter(function(media) {
        return moment(media.get('end')) < timeLimit;
    });
    if (oldMedias) {
        oldMedias.forEach(function(media) {
            self.melted_medias.remove(media);
        });
        self.melted_medias.save();
    }
    console.log("[HEARTBEAT-GC] Finished Garbage Collector: " + oldMedias.length + " removed.");
};

heartbeats.prototype.sendStatus = function() {
    var self = this;
    console.log("[HEARTBEAT-FS] Started Status");
    var media = getExpectedMedia();
    if (!self.current_media)
        self.current_media = media;
    if (media.get("id").toString() !== self.current_media.get("id").toString()) {
        self.emit("clipStatus", media);
        self.current_media = media;
    }
    self.emit("frameStatus", media.current_frame);
    console.log("[HEARTBEAT-FS] Finished Status");
};

heartbeats.prototype.getExpectedMedia = function() {
    var self = this;
    var now = moment();
    var expected = {};
    var media = self.melted_medias.find(function(media) {
        return moment(media.end) >= now;
    });
    if (media) {
        var elapsed = now - moment(media.start);
        var frame = elapsed / media.fps;
        expected.media = media;
        expected.frame = frame;
        return expected;
    } else {
        throw new Error("[HEARTBEAT-SY] Could not find expected clip!");
    }
};

heartbeats.prototype.syncMelted = function() {
    console.log("[HEARTBEAT-SY] Start Sync");
    var self = this;
    self.server.getServerStatus(function(meltedStatus) {
        if (meltedStatus.status !== "playing") {
            self.handleError(new Error("[HEARTBEAT-SY] Melted is not playing!"));
        } else {
            try {
                var expected = self.getExpectedMedia();
                var meltedClip = meltedStatus.clip;
                if (expected.media.get("id").toString() !== meltedClip.id.toString()) {
                    var index = self.melted_medias.indexOf(expected.media);
                    var frames = 9999;
                    var mediaAbove = self.melted_medias.at(index - 1);
                    if (mediaAbove.get("id").toString() === meltedClip.id.toString()) {
                        frames = meltedClip.length - meltedClip.currentFrame + expected.frame;
                    } else {
                        var mediaBelow = self.melted_medias.at(index + 1);
                        if (mediaBelow.get("id").toString() === meltedClip.id.toString()) {
                            var length = undefined;
                            if (!isNaN(parseFloat(expected.media.length)) && isFinite(expected.media.length)) {
                                //length is numeric (frames)
                                length = expected.media.length;
                            } else {
                                length = utils.convertTimeToFrames(expected.media.length, exptected.media.fps);
                            }
                            frames = meltedClip.currentFrame + (length - expected.frame);
                        }
                    }
                    if (frames > expected.media.fps)
                        self.fixMelted(expected);
                } else if (Math.abs(meltedClip.currentFrame - expected.frame) > expected.media.fps) {
                    self.fixMelted(expected);
                } else {
                    self.sendStatus();
                }
            } catch(err) {
                self.handleError(error);
            }            
        }
    }, self.handleError);
    console.log("[HEARTBEAT-SY] Finish Sync");
};

heartbeats.prototype.fixMelted = function(expected) {
    console.error("[HEARTBEAT-SY] Melted is out of sync!");
    self.server.goto(expected.media.actual_order, expected.frame, self.sendStatus, self.handleError);
};

heartbeats.prototype.handleError =  function(error) {
    console.error(error);
    //FORCING LIST TO SYNC, SHOULD CHECK MELTED PLAYLIST, FIX IT AND START PLAYING
    self.melted_medias.save();
};

exports = module.exports = function(customConfig) {
    util.inherits(heartbeats, events.EventEmitter);
    var hb = new heartbeats(customConfig);
    return hb;
};