// The dashboard's 3D Hallway: the accounts as doors in a building, a floor of
// a few doors each, stacked. Blocked accounts are doors left open with blood
// on the floor in front of them; the current account is the door a hooded
// skeleton knocks on; the rest are shut and waiting.
//
// Like the page's shared helpers, createHall3d reaches the browser as its own
// source text (dashboard.js serializes it with toString()), so it closes over
// nothing at module scope. It is the one part of the page that loads anything
// from elsewhere: three.js from jsDelivr, pinned to `libBase`, and only when
// the 3D view is picked; the CC0 models (src/dashboard-assets) come from the
// proxy itself. Everything it shows arrives through update() from the status
// the page already fetched, and names reach the page as textContent only.

/* global document, window, getComputedStyle */

/**
 * @param {{
 *   container: any, libBase: string, assetBase: string,
 *   onOpen?: (name: string) => void, reducedMotion?: boolean,
 * }} opts
 * @returns {Promise<{ update: (rows: any[], canOpen: boolean) => void, knock: () => void, setActive: (on: boolean) => void, destroy: () => void }>}
 */
export function createHall3d(opts) {
  // The import URLs are variables, not literals: the module never resolves
  // them, the browser does.
  var lib = opts.libBase;
  var urls = [lib + '+esm', lib + 'examples/jsm/loaders/GLTFLoader.js/+esm', lib + 'examples/jsm/utils/SkeletonUtils.js/+esm'];
  return Promise.all(urls.map(function (u) { return import(u); })).then(function (mods) {
    var THREE = mods[0], GLTFLoader = mods[1].GLTFLoader, SkeletonUtils = mods[2];
    var loader = new GLTFLoader();
    var load = function (/** @type {string} */ name) {
      return new Promise(function (resolve, reject) { loader.load(opts.assetBase + name, resolve, undefined, reject); });
    };
    return Promise.all([load('doorway.glb'), load('skeleton.glb')]).then(function (assets) {
      return build(THREE, SkeletonUtils, assets[0], assets[1]);
    });
  });

  // three.js arrives at run time from the CDN, untyped here: its objects are
  // `any` to the checker.
  /** @param {any} THREE @param {any} SkeletonUtils @param {any} doorGltf @param {any} skelGltf */
  function build(THREE, SkeletonUtils, doorGltf, skelGltf) {
    // The grid, in the models' own units: a slot is one metre of wall with a
    // Kenney doorway (0.49 wide, 1.01 tall) in the middle of it.
    var SLOT = 1, FLOOR_H = 1.29, SLAB = 0.07, DEPTH = 0.78, BACK = 0.5, SIDE = 0.12;
    var DOOR_X = 0.255, DOOR_W = 0.49, DOOR_H = 1.01, WALL_T = 0.09;
    // Positive swings the leaf's free edge back, into the room.
    var OPEN_ANGLE = 1.15;
    // The raps land where the page plays them: 0.1s, 0.3s and 0.5s into a round.
    var RAPS = [0.1, 0.3, 0.5], RAP_LEN = 0.09;
    var reduced = !!opts.reducedMotion;

    var container = opts.container;
    container.textContent = '';
    var stage = document.createElement('div');
    stage.className = 'h3-stage';
    var canvas = document.createElement('canvas');
    canvas.className = 'h3-canvas';
    stage.appendChild(canvas);
    var labelLayer = document.createElement('div');
    labelLayer.className = 'h3-labels';
    stage.appendChild(labelLayer);
    container.appendChild(stage);

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(28, 2, 0.05, 60);
    var hemi = new THREE.HemisphereLight(0xe8eef0, 0x40342a, 1.7);
    scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xfff1dc, 1.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);

    // Materials the theme recolours. The doors keep the model's own wood.
    var mats = {
      wall: new THREE.MeshStandardMaterial({ color: 0xcfd6d0, roughness: 0.92 }),
      floor: new THREE.MeshStandardMaterial({ color: 0xd9d2c8, roughness: 0.7 }),
      slabEdge: new THREE.MeshStandardMaterial({ color: 0x9c9c9f, roughness: 0.8 }),
      voidIn: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, side: THREE.BackSide }),
      voidBlood: new THREE.MeshStandardMaterial({ color: 0x120202, emissive: 0x2a0000, roughness: 1, side: THREE.BackSide }),
      blood: new THREE.MeshStandardMaterial({ color: 0xb3121a, roughness: 0.18, metalness: 0.05 }),
      robe: new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.95, side: THREE.DoubleSide }),
      hoodIn: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 1, side: THREE.BackSide }),
      pole: new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.7 }),
      blade: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.25, metalness: 0.85, side: THREE.DoubleSide }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffd9a0, emissiveIntensity: 1.6 }),
      hit: new THREE.MeshBasicMaterial({ visible: false }),
    };
    var colorsFrom = '';

    /** @param {string} name @param {string} fallback */
    function token(name, fallback) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    }

    function retheme() {
      var c = [token('--wall-a', '#cfd6d0'), token('--floor-a', '#d9d2c8'), token('--baseboard', '#9c9c9f'), token('--blood', '#b3121a'), token('--lime', '#d6ff4f')];
      var key = c.join(',');
      if (key === colorsFrom) return;
      colorsFrom = key;
      mats.wall.color.set(c[0]);
      mats.floor.color.set(c[1]);
      mats.slabEdge.color.set(c[2]);
      mats.blood.color.set(c[3]);
      limeColor.set(c[4]);
      Object.keys(doors).forEach(function (k) { paintDoor(doors[k]); });
    }
    var limeColor = new THREE.Color(0xd6ff4f);
    var black = new THREE.Color(0x000000);

    /** @param {any} o */
    function shadowed(o) {
      o.traverse(function (/** @type {any} */ m) { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      return o;
    }

    // ── The knock's flash, a star drawn once onto a canvas ──────────────────
    var burstTex = (function () {
      var cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      var g = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
      g.translate(64, 64);
      g.strokeStyle = '#fff8dc';
      g.lineWidth = 6;
      g.lineJoin = 'round';
      g.beginPath();
      for (var i = 0; i < 20; i++) {
        var r = i % 2 ? 26 : (i % 4 ? 46 : 58);
        var a = -Math.PI / 2 + i * Math.PI / 10;
        g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath();
      g.stroke();
      var t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();

    // ── A door: Kenney's doorway, the dark room behind it, its blood ────────
    var doorProto = doorGltf.scene;
    shadowed(doorProto);
    var doors = Object.create(null);
    /** @type {any[]} */
    var hits = [];

    /** @param {string} s */
    function hash(s) {
      var h = 2166136261;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    }

    // A pool spilling out from under the door, its outline different for each
    // account so a row of them does not read as one stamp repeated.
    /** @param {number} seed */
    function bloodGeometry(seed) {
      var shape = new THREE.Shape();
      var n = 28, rnd = function (/** @type {number} */ k) { return ((Math.sin(seed * 0.001 + k * 12.9898) * 43758.5453) % 1 + 1) % 1; };
      for (var i = 0; i <= n; i++) {
        var a = (i % n) / n * Math.PI * 2;
        var r = 1 + 0.22 * Math.sin(3 * a + rnd(1) * 6) + 0.14 * Math.sin(7 * a + rnd(2) * 6) + 0.08 * Math.sin(13 * a);
        var x = Math.cos(a) * r * 0.34, y = Math.sin(a) * r * 0.2;
        if (i) shape.lineTo(x, y); else shape.moveTo(x, y);
      }
      var g = new THREE.ShapeGeometry(shape, 2);
      g.rotateX(-Math.PI / 2);
      return g;
    }

    /** @param {string} key @param {string} name */
    function makeDoor(key, name) {
      var root = new THREE.Group();
      var model = doorProto.clone(true);
      model.position.set(DOOR_X, 0, 0);
      root.add(model);
      var leaf = model.getObjectByName('door');
      // The frame's wood, its own copy so the current door can glow.
      /** @type {any} */
      var frame = null;
      model.traverse(function (/** @type {any} */ m) { if (m.isMesh && m !== leaf && !frame && m.parent !== leaf) frame = m; });
      if (frame) { frame.material = frame.material.clone(); }
      var room = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W - 0.02, DOOR_H, BACK - WALL_T), mats.voidIn);
      room.position.set(DOOR_X + DOOR_W / 2, DOOR_H / 2, -WALL_T - (BACK - WALL_T) / 2);
      root.add(room);
      var pool = new THREE.Group();
      var blood = new THREE.Mesh(bloodGeometry(hash(name)), mats.blood);
      blood.receiveShadow = true;
      blood.position.set(0, 0, 0.16);
      pool.add(blood);
      // A smear from the threshold out to the pool.
      var smear = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W * 0.7, 0.2), mats.blood);
      smear.rotation.x = -Math.PI / 2;
      smear.position.set(0, 0, 0.02);
      pool.add(smear);
      pool.position.set(DOOR_X + DOOR_W / 2, 0.003, 0);
      pool.scale.set(0.001, 1, 0.001);
      pool.visible = false;
      root.add(pool);
      var hit = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.12), mats.hit);
      hit.position.set(DOOR_X + DOOR_W / 2, DOOR_H / 2, 0.02);
      root.add(hit);
      var label = document.createElement('div');
      label.className = 'h3-label';
      var ln = document.createElement('b');
      var ls = document.createElement('span');
      label.appendChild(ln);
      label.appendChild(ls);
      labelLayer.appendChild(label);
      scene.add(root);
      var d = {
        key: key, name: name, root: root, leaf: leaf, frame: frame, room: room, pool: pool, hit: hit,
        label: label, labelName: ln, labelState: ls,
        state: 'waiting', open: 0, spill: 0, rattle: 0, target: new THREE.Vector3(), placed: false,
      };
      hit.userData.door = d;
      hits.push(hit);
      doors[key] = d;
      return d;
    }

    /** @param {any} d */
    function paintDoor(d) {
      if (d.frame) {
        d.frame.material.emissive.copy(d.state === 'current' ? limeColor : black);
        d.frame.material.emissiveIntensity = d.state === 'current' ? 0.55 : 0;
      }
      d.room.material = d.state === 'blocked' ? mats.voidBlood : mats.voidIn;
      d.label.className = 'h3-label h3-' + d.state;
    }

    /** @param {any} d */
    function dropDoor(d) {
      scene.remove(d.root);
      d.label.remove();
      hits.splice(hits.indexOf(d.hit), 1);
      delete doors[d.key];
    }

    // ── The knocker: Quaternius's skeleton under a robe and hood ────────────
    var skelProto = skelGltf.scene;
    var skelClips = skelGltf.animations;
    // Sized by the loaded model's whole box, its matrices brought up to date
    // first: a skinned mesh's own bounds are in its Z-up bind space, and a
    // fresh clone's world matrices are not computed yet.
    skelProto.updateMatrixWorld(true);
    var skelBox = new THREE.Box3().setFromObject(skelProto);
    var reapers = Object.create(null);

    function robeGeometry() {
      // Shoulders to a ragged hem, spun about the vertical.
      /** @type {any[]} */
      var pts = [];
      var prof = [[0.05, 0.6], [0.11, 0.57], [0.15, 0.5], [0.17, 0.38], [0.2, 0.24], [0.23, 0.1], [0.26, 0.0]];
      prof.forEach(function (p) { pts.push(new THREE.Vector2(p[0], p[1])); });
      var g = new THREE.LatheGeometry(pts, 28);
      var pos = g.attributes.position;
      for (var i = 0; i < pos.count; i++) {
        var y = pos.getY(i);
        if (y < 0.12) {
          var a = Math.atan2(pos.getZ(i), pos.getX(i));
          pos.setY(i, y + 0.035 * Math.sin(a * 5) * (1 - y / 0.12));
        }
      }
      g.computeVertexNormals();
      return g;
    }

    function scytheGroup() {
      var g = new THREE.Group();
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 1.02, 10), mats.pole);
      pole.position.y = 0.51;
      g.add(pole);
      var s = new THREE.Shape();
      s.moveTo(0, 0);
      s.bezierCurveTo(-0.12, 0.06, -0.3, 0.02, -0.42, -0.16);
      s.bezierCurveTo(-0.3, -0.06, -0.14, -0.02, 0, -0.05);
      s.lineTo(0, 0);
      // The blade sweeps back, behind its holder, so at the end of a floor
      // it stays inside the building instead of cutting through the wall.
      var head = new THREE.Group();
      head.rotation.y = -Math.PI / 2;
      g.add(head);
      var blade = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.008, bevelEnabled: false }), mats.blade);
      blade.position.set(0, 1.0, -0.004);
      head.add(blade);
      // Blood along the blade's edge, dripping off its point.
      var edge = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), mats.blood);
      edge.scale.set(1.3, 0.55, 0.5);
      edge.position.set(-0.38, 0.87, 0);
      head.add(edge);
      var drip = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), mats.blood);
      drip.position.set(-0.41, 0.8, 0);
      drip.scale.y = 1.6;
      head.add(drip);
      return shadowed(g);
    }

    /** @param {string} provider */
    function makeReaper(provider) {
      var root = new THREE.Group();
      var body = new THREE.Group();
      root.add(body);
      var skel = SkeletonUtils.clone(skelProto);
      var armor = skel.getObjectByName('Armor');
      if (armor) armor.visible = false;
      var k = 0.86 / Math.max(0.001, skelBox.max.y - skelBox.min.y);
      var box = skelBox;
      skel.scale.setScalar(k);
      skel.position.y = -box.min.y * k;
      body.add(shadowed(skel));
      var robe = new THREE.Mesh(robeGeometry(), mats.robe);
      robe.castShadow = true;
      body.add(robe);
      // The hood: a dark shell over the skull, open to the front. The model's
      // skull is a big cube, so the shell is wide enough for its corners.
      var hood = new THREE.Mesh(new THREE.SphereGeometry(0.2, 22, 16, Math.PI * 0.64, Math.PI * 1.72, 0, Math.PI * 0.68), mats.robe);
      hood.scale.set(1, 1.08, 1.05);
      hood.castShadow = true;
      var hoodIn = new THREE.Mesh(hood.geometry, mats.hoodIn);
      hood.add(hoodIn);
      body.add(hood);
      var scythe = scytheGroup();
      // In the right hand, on the far side from the door.
      scythe.position.set(-0.2, 0, 0.06);
      scythe.rotation.z = 0.08;
      body.add(scythe);
      var mixer = new THREE.AnimationMixer(skel);
      var idle = skelClips.filter(function (/** @type {any} */ c) { return /Idle$/.test(c.name); })[0];
      if (idle) mixer.clipAction(idle).play();
      var flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: burstTex, transparent: true, opacity: 0, depthWrite: false }));
      flash.scale.setScalar(0.16);
      scene.add(flash);
      scene.add(root);
      /** @type {Record<string, any>} */
      var bones = {};
      skel.traverse(function (/** @type {any} */ o) { if (o.isBone) bones[o.name] = o; });
      var r = {
        provider: provider, root: root, body: body, skel: skel, hood: hood, mixer: mixer, flash: flash,
        arm: bones.ArmL || null, armRest: bones.ArmL ? bones.ArmL.quaternion.clone() : null, head: bones.Head || null,
        pos: new THREE.Vector3(), target: new THREE.Vector3(), floorY: 0, fade: 1, moving: 0, placed: false,
        door: null, idle: false, knockAt: -1, phase: Math.random() * 6,
      };
      reapers[provider] = r;
      return r;
    }

    /** @param {any} r */
    function dropReaper(r) {
      scene.remove(r.root);
      scene.remove(r.flash);
      delete reapers[r.provider];
    }

    // ── The building: a floor per row of doors, stacked ─────────────────────
    var structure = new THREE.Group();
    scene.add(structure);
    /** @type {any[]} */
    var lamps = [];
    var builtFrom = '';
    var layout = { perFloor: 5, floors: 0, width: 5, height: 0, margin: 0 };
    /** @type {{ el: any, x: number, y: number }[]} */
    var floorLabels = [];

    // One wall the length of the floor, a notch cut up from its foot for each
    // door it has: an empty slot at the end of a short floor is plain wall.
    /** @param {number} n @param {number} doorCount */
    function floorWall(n, doorCount) {
      var s = new THREE.Shape();
      s.moveTo(0, 0);
      for (var j = 0; j < doorCount; j++) {
        var a = j * SLOT + DOOR_X + 0.01, b = j * SLOT + DOOR_X + DOOR_W - 0.01;
        s.lineTo(a, 0);
        s.lineTo(a, DOOR_H - 0.01);
        s.lineTo(b, DOOR_H - 0.01);
        s.lineTo(b, 0);
      }
      s.lineTo(n * SLOT, 0);
      s.lineTo(n * SLOT, FLOOR_H);
      s.lineTo(0, FLOOR_H);
      s.lineTo(0, 0);
      var g = new THREE.ExtrudeGeometry(s, { depth: WALL_T, bevelEnabled: false });
      g.translate(0, 0, -WALL_T);
      return g;
    }

    /** @param {number} width @param {number} y */
    function slab(width, y) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(width + SIDE * 2, SLAB, DEPTH + BACK), [mats.slabEdge, mats.slabEdge, mats.floor, mats.slabEdge, mats.slabEdge, mats.slabEdge]);
      m.position.set(width / 2, y - SLAB / 2, (DEPTH - BACK) / 2);
      // The building takes shadows but casts none: a ceiling's shadow would
      // black out the top of every wall under it.
      m.receiveShadow = true;
      return m;
    }

    /** @param {any[]} floors @param {number} perFloor */
    function rebuildStructure(floors, perFloor) {
      structure.children.slice().forEach(function (/** @type {any} */ c) { structure.remove(c); if (c.geometry) c.geometry.dispose(); });
      lamps.forEach(function (l) { scene.remove(l); });
      lamps = [];
      floorLabels.forEach(function (l) { l.el.remove(); });
      floorLabels = [];
      var W = perFloor * SLOT;
      var storey = FLOOR_H + SLAB;
      floors.forEach(function (/** @type {any} */ f, /** @type {number} */ i) {
        var y0 = (floors.length - 1 - i) * storey;
        var wall = new THREE.Mesh(floorWall(perFloor, f.doors.length), mats.wall);
        wall.position.y = y0;
        wall.receiveShadow = true;
        structure.add(wall);
        structure.add(slab(W, y0));
        [-SIDE / 2, W + SIDE / 2].forEach(function (x) {
          var side = new THREE.Mesh(new THREE.BoxGeometry(SIDE, FLOOR_H, DEPTH + BACK), mats.wall);
          side.position.set(x, y0 + FLOOR_H / 2, (DEPTH - BACK) / 2);
          side.receiveShadow = true;
          structure.add(side);
        });
        // A ceiling lamp halfway along, and its light.
        var bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.03, 16), mats.lamp);
        bulb.position.set(W / 2, y0 + FLOOR_H - 0.02, DEPTH * 0.45);
        structure.add(bulb);
        var light = new THREE.PointLight(0xffd9a0, 1.4, W * 1.1, 1.6);
        light.position.set(W / 2, y0 + FLOOR_H - 0.12, DEPTH * 0.5);
        scene.add(light);
        lamps.push(light);
        if (f.label) {
          var tag = document.createElement('div');
          tag.className = 'h3-floor';
          tag.textContent = f.label;
          labelLayer.appendChild(tag);
          // In the margin to the left of its floor, reading up, clear of the
          // door names along the top of the wall.
          floorLabels.push({ el: tag, x: -SIDE - 0.06, y: y0 + FLOOR_H / 2 });
        }
      });
      structure.add(slab(W, floors.length * storey));
      layout.perFloor = perFloor;
      layout.floors = floors.length;
      layout.width = W;
      layout.margin = floorLabels.length ? 0.32 : 0;
      layout.height = floors.length * storey;
      var h = layout.height;
      sun.position.set(W * 0.75, h * 0.8 + 2, 7);
      sun.target.position.set(W / 2, h / 2, 0);
      var sc = sun.shadow.camera;
      var ext = Math.max(W, h) * 0.75 + 1;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 0.5; sc.far = h + 12;
      sc.updateProjectionMatrix();
      fit();
    }

    // ── Fitting the canvas and camera to the building ───────────────────────
    var size = { w: 0, h: 0 };
    var view = { x: 0, y: 0, dist: 10 };

    function fit() {
      var w = Math.max(240, container.clientWidth || 800);
      // As tall as the building drawn at the card's width, and no taller
      // than most of a screen: a many-floored fleet zooms out instead.
      var aspectH = (layout.height + 0.5) / (layout.width + layout.margin + SIDE * 2 + 0.6);
      var maxH = Math.max(320, (window.innerHeight || 900) * 0.85);
      var h = Math.round(Math.min(maxH, Math.max(260, w * aspectH * 1.02)));
      if (w !== size.w || h !== size.h) {
        size.w = w; size.h = h;
        renderer.setSize(w, h, false);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        stage.style.height = h + 'px';
      }
      camera.aspect = w / h;
      var vfov = camera.fov * Math.PI / 180;
      var hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      var bw = layout.width + layout.margin + SIDE * 2 + 0.5, bh = layout.height + 0.35;
      var dist = Math.max(bw / 2 / Math.tan(hfov / 2), bh / 2 / Math.tan(vfov / 2)) * 1.04 + DEPTH;
      view.dist = dist;
      camera.updateProjectionMatrix();
      placeCamera();
    }

    function placeCamera() {
      var cx = (layout.width - layout.margin) / 2, cy = layout.height / 2;
      // From a little above and to the right, looking down enough to see the
      // floors, which is where the blood is. It holds still: the building
      // does not swing about under the pointer.
      camera.position.set(cx + 0.35, cy + view.dist * 0.2, view.dist);
      camera.lookAt(cx, cy - 0.12, 0.2);
    }

    // ── update(): the status, as floors of doors ────────────────────────────
    var canOpen = false;
    /** @type {any[]} */
    var lastRows = [];

    function perFloorFor() {
      var w = container.clientWidth || 800;
      return w >= 760 ? 5 : w >= 480 ? 4 : 3;
    }

    /** @param {any[]} rows @param {boolean} open */
    function update(rows, open) {
      lastRows = rows;
      canOpen = !!open;
      retheme();
      var perFloor = perFloorFor();
      /** @type {any[]} */
      var floors = [];
      rows.forEach(function (/** @type {any} */ r) {
        for (var i = 0; i < r.doors.length; i += perFloor) {
          floors.push({ provider: r.provider, label: i === 0 && rows.length > 1 ? r.label : '', doors: r.doors.slice(i, i + perFloor) });
        }
      });
      var shape = perFloor + '|' + floors.map(function (f) { return f.doors.length + (f.label ? ':' + f.label : ''); }).join(',');
      if (shape !== builtFrom) { builtFrom = shape; rebuildStructure(floors, perFloor); }
      var storey = FLOOR_H + SLAB;
      var seen = Object.create(null), seenReapers = Object.create(null);
      floors.forEach(function (/** @type {any} */ f, /** @type {number} */ i) {
        var y0 = (floors.length - 1 - i) * storey;
        f.doors.forEach(function (/** @type {any} */ dd, /** @type {number} */ j) {
          var key = f.provider + ':' + dd.name;
          seen[key] = true;
          var d = doors[key] || makeDoor(key, dd.name);
          d.target.set(j * SLOT, y0, 0);
          if (!d.placed) { d.root.position.copy(d.target); d.placed = true; }
          if (d.state !== dd.state) { d.state = dd.state; paintDoor(d); }
          d.labelName.textContent = dd.short || dd.name;
          d.labelState.textContent = dd.stateText || dd.state;
          d.title = dd.title || dd.name;
          if (dd.state === 'current') {
            seenReapers[f.provider] = true;
            var r = reapers[f.provider] || makeReaper(f.provider);
            r.door = d;
            r.idle = false;
            // In front of the door's hinge side, turned to it, as in the
            // drawing: near enough that a raised arm lands on its panel.
            var tx = j * SLOT + DOOR_X - 0.02, tz = 0.24;
            if (!r.placed) { r.pos.set(tx, y0, tz); r.placed = true; }
            if (Math.abs(r.floorY - y0) > 0.01 && r.placed && r.root.visible) r.moving = 1;
            r.target.set(tx, y0, tz);
            r.floorY = y0;
          }
        });
      });
      // A corridor with nothing to knock on: its knocker waits, arm down,
      // past the last door of its last floor.
      rows.forEach(function (/** @type {any} */ r) {
        if (seenReapers[r.provider] || !r.doors.length) return;
        var rp = reapers[r.provider];
        if (!rp) return;
        seenReapers[r.provider] = true;
        var last = floors.filter(function (f) { return f.provider === r.provider; }).pop();
        var li = floors.indexOf(last);
        var y0 = (floors.length - 1 - li) * storey;
        rp.door = null;
        rp.idle = true;
        rp.target.set(Math.min(last.doors.length, perFloor - 0.3) * SLOT - 0.1, y0, 0.45);
        rp.floorY = y0;
      });
      Object.keys(doors).forEach(function (k) { if (!seen[k]) dropDoor(doors[k]); });
      Object.keys(reapers).forEach(function (p) { if (!seenReapers[p]) dropReaper(reapers[p]); });
    }

    // ── The loop ───────────────────────────────────────────────────────────
    var last = 0, now = 0;
    var active = false;
    var tmp = new THREE.Vector3();
    var raycaster = new THREE.Raycaster();
    var ndc = new THREE.Vector2();
    /** @type {any} */
    var hovered = null;

    /** @param {number} t */
    function knockCurve(t) {
      // 1 at each rap's contact, easing back to 0 between them.
      var v = 0;
      RAPS.forEach(function (at) {
        var x = (t - at + RAP_LEN) / RAP_LEN;
        if (x > 0 && x < 2) v = Math.max(v, x < 1 ? x : 2 - x);
      });
      return v;
    }

    /** @param {number} cur @param {number} target @param {number} rate @param {number} dt */
    function approach(cur, target, rate, dt) {
      return reduced ? target : cur + (target - cur) * (1 - Math.exp(-rate * dt));
    }

    function tick() {
      var t0 = window.performance.now() / 1000;
      var dt = last ? Math.min(0.05, t0 - last) : 0;
      last = t0;
      now += dt;
      Object.keys(doors).forEach(function (k) {
        var d = doors[k];
        d.root.position.lerp(d.target, reduced ? 1 : 1 - Math.exp(-6 * dt));
        var wantOpen = d.state === 'blocked' ? 1 : 0;
        d.open = approach(d.open, wantOpen, 2.4, dt);
        // The blood follows the door, a beat behind it.
        d.spill = approach(d.spill, wantOpen && d.open > 0.6 ? 1 : 0, wantOpen ? 1.1 : 4, dt);
        d.rattle = approach(d.rattle, 0, 18, dt);
        if (d.leaf) d.leaf.rotation.y = OPEN_ANGLE * d.open + d.rattle * 0.06;
        d.pool.visible = d.spill > 0.01;
        d.pool.scale.set(Math.max(0.001, d.spill), 1, Math.max(0.001, d.spill));
      });
      Object.keys(reapers).forEach(function (p) {
        var r = reapers[p];
        // Back to the rest pose before the mixer runs: a bone its clip does
        // not animate would otherwise keep every frame's reach added on.
        if (r.arm) r.arm.quaternion.copy(r.armRest);
        r.mixer.update(dt);
        // Between floors it does not walk: it fades out and back in.
        if (r.moving > 0 && !reduced) {
          r.fade = Math.max(0, r.fade - dt * 3);
          if (r.fade === 0) { r.pos.copy(r.target); r.moving = 0; }
        } else {
          r.fade = Math.min(1, r.fade + dt * 3);
          r.pos.lerp(r.target, reduced ? 1 : 1 - Math.exp(-2.2 * dt));
        }
        var bob = reduced ? 0 : Math.sin(now * 1.8 + r.phase) * 0.025;
        r.root.position.set(r.pos.x, r.pos.y + 0.065 + bob, r.pos.z);
        r.root.scale.setScalar(0.4 + 0.6 * r.fade);
        r.root.visible = r.fade > 0.02;
        // Turned a third of the way to the door, its face still to the room;
        // waiting, it faces the room.
        var face = r.door ? 0.6 : 0.15;
        r.root.rotation.y = approach(r.root.rotation.y, face, 5, dt);
        // The robe and hood sway a little behind the body.
        r.body.rotation.z = reduced ? 0 : Math.sin(now * 1.3 + r.phase) * 0.03;
        if (r.head) {
          // The head bone sits at the neck; the hood centres on the skull.
          r.head.getWorldPosition(tmp);
          r.body.worldToLocal(tmp);
          r.hood.position.set(tmp.x, tmp.y + 0.115, tmp.z - 0.015);
        }
        var t = r.knockAt >= 0 ? now - r.knockAt : 99;
        var k = t < 0.7 ? knockCurve(t) : 0;
        if (r.arm) {
          // The left arm raised out to the door, and each rap a drop of the
          // fist onto it. Waiting, it hangs.
          r.reach = approach(r.reach || 0, r.idle ? 0 : 1, 4, dt);
          r.arm.rotateZ(1.3 * r.reach - 0.32 * k);
        }
        if (r.door && t < 0.7) {
          var contact = knockCurve(t) > 0.85;
          r.flash.material.opacity = contact ? 1 : Math.max(0, r.flash.material.opacity - dt * 9);
          if (contact) r.door.rattle = 1;
          r.flash.position.set(r.root.position.x + 0.24, r.door.root.position.y + 0.56, 0.1);
          r.flash.scale.setScalar(0.12 + 0.08 * (1 - r.flash.material.opacity));
        } else {
          r.flash.material.opacity = Math.max(0, r.flash.material.opacity - dt * 9);
        }
      });
      renderer.render(scene, camera);
      placeLabels();
    }

    /** @param {number} x @param {number} y @param {number} z */
    function project(x, y, z) {
      tmp.set(x, y, z).project(camera);
      return { x: (tmp.x + 1) / 2 * size.w, y: (1 - tmp.y) / 2 * size.h, z: tmp.z };
    }

    function placeLabels() {
      // A name gets its own slot's width on screen and no more, so a narrow
      // card's names ellipsize rather than run into each other.
      var span = Math.max(40, project(SLOT, 0, 0.02).x - project(0, 0, 0.02).x - 6);
      Object.keys(doors).forEach(function (k) {
        var d = doors[k];
        var p = project(d.root.position.x + SLOT / 2, d.root.position.y + DOOR_H + 0.14, 0.02);
        d.label.style.transform = 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px) translate(-50%,-50%)';
        d.label.style.width = span.toFixed(0) + 'px';
      });
      floorLabels.forEach(function (f) {
        var p = project(f.x, f.y, 0.02);
        f.el.style.transform = 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px) translate(-50%,-50%) rotate(-90deg)';
      });
    }

    /** @param {boolean} on */
    function setActive(on) {
      if (on === active) return;
      active = on;
      last = 0;
      if (on) { fit(); renderer.setAnimationLoop(tick); } else renderer.setAnimationLoop(null);
    }

    function knock() {
      Object.keys(reapers).forEach(function (p) { if (reapers[p].door) reapers[p].knockAt = now; });
    }

    /** @param {any} e */
    function pick(e) {
      var rect = canvas.getBoundingClientRect();
      ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      var hit = raycaster.intersectObjects(hits, false)[0];
      return hit ? hit.object.userData.door : null;
    }

    /** @param {any} e */
    function onMove(e) {
      var d = pick(e);
      if (d !== hovered) {
        hovered = d;
        canvas.style.cursor = d && canOpen ? 'pointer' : '';
        canvas.title = d ? d.title : '';
      }
    }

    function onLeave() { hovered = null; canvas.title = ''; canvas.style.cursor = ''; }

    /** @param {any} e */
    function onClick(e) {
      var d = pick(e);
      if (d && canOpen && opts.onOpen) opts.onOpen(d.name);
    }

    function onResize() {
      if (perFloorFor() !== layout.perFloor) update(lastRows, canOpen);
      fit();
    }

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('click', onClick);
    window.addEventListener('resize', onResize);

    function destroy() {
      renderer.setAnimationLoop(null);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      container.textContent = '';
    }

    retheme();
    return {
      update: update,
      knock: knock,
      setActive: setActive,
      destroy: destroy,
    };
  }
}
