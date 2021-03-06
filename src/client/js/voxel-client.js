var extend = require('extend');
var websocket = require('websocket-stream');
var engine = require('voxel-engine');
var duplexEmitter = require('duplex-emitter');
var crunch = require('voxel-crunch');
var emitChat = require('./client-chat');
var fly = require('voxel-fly');
var highlight = require('voxel-highlight');
var skin = require('minecraft-skin');
var player = require('voxel-player');
var createPlugins = require('voxel-plugins');
var voiceChat = require('./voice-chat');

// voxel-plugins
require('voxel-blockdata');

module.exports = Client;

function Client(opts) {
  if (!(this instanceof Client)) {
    return new Client(opts);
  }
  this.opts = opts || {}
  this.playerID;
  this.lastProcessedSeq = 0;
  this.localInputs = [];
  this.connected = false;
  this.currentMaterial = 1;
  this.lerpPercent = 0.1;
  this.server = opts.server || window.location.origin.replace(/^http/, 'ws');
  this.others = {};
  this.connect(this.server, opts.game);
  this.game;
  this.room = opts.room;
  window.others = this.others;
}

Client.prototype.connect = function(server, game) {
  var self = this;
  var socket = websocket(server)
  socket.on('end', function() {
    self.connected = false;
  });
  this.socket = socket;
  this.bindEvents(socket, game);
};

Client.prototype.bindEvents = function(socket, game) {
  var self = this;
  this.emitter = duplexEmitter(socket);
  var emitter = this.emitter;
  this.connected = true;

  voiceChat(emitter);

  emitter.on('id', function(id) {
    console.log('got id', id);
    self.playerID = id;
    if (game != null) {
      self.game = game;
      emitter.emit('clientSettings', self.game.settings);
    } else {
      emitter.emit('clientSettings', null);
    }
  });

  emitter.on('settings', function(settings) {
    settings.generateChunks = false;
      //deserialise the voxel.generator function.
    if (settings.generatorToString != null) {
      settings.generate = eval("(" + settings.generatorToString + ")");
    }
    self.game = self.createGame(settings, game);
    emitter.emit('created', self.room);
    emitter.on('chunk', function(encoded, chunk) {
      var voxels = crunch.decode(encoded, new Uint32Array(chunk.length));
      chunk.voxels = voxels;
      self.game.showChunk(chunk);
    });

    // load voxel-plugins
    var plugins = createPlugins(self.game, {require: require});
    plugins.add('voxel-blockdata', {});
    plugins.loadAll();
    self.blockdata = self.game.plugins.get('voxel-blockdata');
  });

  // fires when server sends us voxel edits
  emitter.on('set', function(pos, val, data) {
    if (!data) {
      self.game.setBlock(pos, val);
    } else {
      self.createLink(pos, data);
    }
  });
};

Client.prototype.createLink = function(pos, data) {
  var self = this;
  // link mesh
  var mesh = new self.game.THREE.Mesh(
    new self.game.THREE.SphereGeometry(0.5, 10, 6),
    new self.game.THREE.MeshNormalMaterial()
  );

  mesh.geometry.applyMatrix(new self.game.THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5));
  mesh.geometry.verticesNeedUpdate = true;
  mesh.position.set(pos[0], pos[1], pos[2]);

  data = extend({ mesh: mesh }, data);

  self.blockdata.set(pos[0], pos[1], pos[2], data);

  self.game.addItem({
    mesh: mesh,
    size: 1
  });
}

Client.prototype.createGame = function(settings, game) {
  var self = this;
  var emitter = this.emitter;
  settings.controlsDisabled = false;
  self.game = engine(settings);
  self.game.settings = settings;

  self.game.playerFly = false;

  function sendState() {
    if (!self.connected) return;
    var player = self.game.controls.target();

    var state = {
      position: player.yaw.position,
      rotation: {
        y: player.yaw.rotation.y,
        x: player.pitch.rotation.x
      }
    };
    emitter.emit('state', state);
  }

  self.game.controls.on('data', function(state) {

    // Initialize fly if we haven't done so yet.
    // It would be better to just check for this a single time, but
    // it seems the player object is not ready if we do this earlier.
    if (!self.game.playerFly && self.connected) {
      var makeFly = fly(self.game);
      self.game.playerFly = makeFly(self.game.controls.target());
    }

    var interacting = false
    Object.keys(state).map(function(control) {
      if (state[control] != 0) interacting = true;
    });
    if (interacting) sendState();
  });

  emitChat(name, emitter);

  // setTimeout is because three.js seems to throw errors if you add stuff too soon
  setTimeout(function() {
    emitter.on('update', function(updates) {
      Object.keys(updates.positions).map(function(player) {
        var update = updates.positions[player];
        if (player === self.playerID) return self.onServerUpdate(update); // local player
        self.updatePlayerPosition(player, update); // other players
      });
    });
  }, 1000);

  emitter.on('leave', function(id) {
    console.log('player leaving', id)
    if (!self.others[id]) return;
    self.game.scene.remove(self.others[id].mesh);
    delete self.others[id];
  });

  return self.game;
};

Client.prototype.onServerUpdate = function(update) {
  // todo use server sent location
};

Client.prototype.lerpMe = function(position) {
  var to = new this.game.THREE.Vector3();
  to.copy(position);
  var from = this.game.controls.target().yaw.position;
  from.copy(from.lerp(to, this.lerpPercent));
};

Client.prototype.updatePlayerPosition = function(id, update) {
  var pos = update.position;
  var player = this.others[id];
  if (!player) {
    var playerSkin = skin(this.game.THREE, '/img/player.png', {
      scale: new this.game.THREE.Vector3(0.04, 0.04, 0.04)
    });
    var playerMesh = playerSkin.mesh;
    this.others[id] = playerSkin;
    playerMesh.children[0].position.y = 10;
    this.game.scene.add(playerMesh);
  }
  var playerSkin = this.others[id];
  var playerMesh = playerSkin.mesh;
  playerMesh.position.copy(playerMesh.position.lerp(pos, this.lerpPercent));

  // playerMesh.position.y += 17
  playerMesh.children[0].rotation.y = update.rotation.y + (Math.PI / 2);
  playerSkin.head.rotation.z = scale(update.rotation.x, -1.5, 1.5, -0.75, 0.75);
};

function scale(x, fromLow, fromHigh, toLow, toHigh) {
  return (x - fromLow) * (toHigh - toLow) / (fromHigh - fromLow) + toLow;
};
