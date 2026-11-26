#target aftereffects
/* ExtendScript ES3. Reusable Telegram scene builder.
   Reads a prepared shot.jsxinc next to this script.
   Interactive build, or isolated background automation via Prepare_Project.jsx. */
(function () {
    var unattended = $.global.TELEGRAM_AE_AUTOMATION === true;
    function reportError(message) {
        if (unattended) { throw new Error(message); }
        alert(message);
    }
    var base = new File($.fileName).parent;
    var versionFile = new File(base.fsName + "/VERSION");
    versionFile.encoding = "UTF-8";
    if (!versionFile.exists || !versionFile.open("r")) {
        reportError("Не найден VERSION. Скопируйте версию из корня telegram-ae/main и прочитайте правила этой версии.");
        return;
    }
    var templateVersion;
    try { templateVersion = versionFile.read().replace(/^\s+|\s+$/g, ""); }
    finally { versionFile.close(); }
    if (!/^\d+\.\d+\.\d+$/.test(templateVersion)) {
        reportError("Некорректный VERSION. Используйте версию из telegram-ae/main.");
        return;
    }
    var configFile = new File(base.fsName + "/shot.jsxinc");
    if (!configFile.exists) {
        reportError("Не найден shot.jsxinc. Нужна разметка конкретного скриншота по правилам репозитория.");
        return;
    }
    var shot;
    try { shot = $.evalFile(configFile); }
    catch (configError) { reportError("Ошибка чтения shot.jsxinc: " + configError.toString()); return; }
    if (!shot || !shot.settings) { reportError("shot.jsxinc должен вернуть settings и highlights."); return; }
    var CFG = shot.settings;
    var HIGHLIGHTS = shot.highlights || [];
    var voice = CFG.audio;
    var scrollEase = [33.33, 66.67];
    if (CFG.templateVersion !== templateVersion) {
        reportError("Версия shot.jsxinc не совпадает с VERSION " + templateVersion +
            ". Перечитайте все правила, примените изменившиеся настройки и обновите templateVersion.");
        return;
    }
    if (CFG.mappingStatus !== "measured") {
        reportError("Это пример конфигурации. Сначала разметьте новый скриншот и подготовьте shot.jsxinc со статусом measured.");
        return;
    }


    function fail(message) { throw new Error(message); }
    function requiredProperty(group, matchName) {
        if (!group) { fail("Не найдена родительская группа для свойства AE: " + matchName); }
        var prop = group.property(matchName);
        if (!prop) {
            fail("Не найдено обязательное свойство AE: " + matchName + " (группа: " + group.name + ")");
        }
        return prop;
    }
    function tr(layer) { return requiredProperty(layer, "ADBE Transform Group"); }
    function fileAt(path) {
        if (/^(?:[A-Za-z]:[\\\/]|[\\\/]{2})/.test(path)) { return new File(path); }
        return new File(base.fsName + "/" + path);
    }
    function smooth(prop, influences) {
        if (prop.numKeys < 2) { return; }
        var count = prop.keyInTemporalEase(1).length;
        var startInfluence = influences ? influences[0] : 65;
        var endInfluence = influences ? influences[1] : 65;
        var k, j, incoming, outgoing;
        for (k = 1; k <= prop.numKeys; k++) {
            incoming = []; outgoing = [];
            for (j = 0; j < count; j++) {
                incoming.push(new KeyframeEase(0, endInfluence));
                outgoing.push(new KeyframeEase(0, startInfluence));
            }
            prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            prop.setTemporalEaseAtKey(k, incoming, outgoing);
        }
    }
    function animate(prop, begin, end, first, last, eased, influences) {
        prop.setValueAtTime(begin, first);
        prop.setValueAtTime(end, last);
        if (eased) { smooth(prop, influences); }
        else {
            prop.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            prop.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        }
    }
    function normalize(text) { return String(text).toLowerCase().replace(/[^a-z0-9]/g, ""); }
    function findNamed(group, names) {
        var i, j, p, found, label;
        for (i = 1; i <= group.numProperties; i++) {
            p = group.property(i); label = normalize(p.name);
            for (j = 0; j < names.length; j++) {
                if (label === normalize(names[j])) { return p; }
            }
            if (p.propertyType !== PropertyType.PROPERTY) {
                found = findNamed(p, names);
                if (found) { return found; }
            }
        }
        return null;
    }
    function firstColour(group) {
        var i, p, found;
        for (i = 1; i <= group.numProperties; i++) {
            p = group.property(i);
            if (p.propertyType === PropertyType.PROPERTY) {
                if (p.propertyValueType === PropertyValueType.COLOR) { return p; }
            } else {
                found = firstColour(p);
                if (found) { return found; }
            }
        }
        return null;
    }
    function addKeylight(layer) {
        var effects = layer.property("ADBE Effect Parade");
        var catalog = app.effects;
        var match = null, i, candidates, effect, colour, p;
        for (i = 0; i < catalog.length; i++) {
            if (/keylight/i.test(catalog[i].matchName) || /keylight/i.test(catalog[i].displayName)) {
                match = catalog[i].matchName; break;
            }
        }
        if (!match) {
            candidates = ["Keylight 906", "Keylight (1.2)"];
            for (i = 0; i < candidates.length; i++) {
                if (effects.canAddProperty(candidates[i])) { match = candidates[i]; break; }
            }
        }
        if (!match || !effects.canAddProperty(match)) {
            fail("Keylight не найден в этой установке After Effects.");
        }
        effect = effects.addProperty(match);
        effect.name = "KEYLIGHT_GREEN_BACKGROUND";
        colour = findNamed(effect, ["Screen Colour", "Screen Color"]);
        // In Keylight 1.2 the first colour parameter is Screen Colour.
        if (!colour) { colour = firstColour(effect); }
        if (!colour) { fail("Не найден параметр Screen Colour в Keylight."); }
        colour.setValue(colour.value.length === 3 ? CFG.screenColour.slice(0, 3) : CFG.screenColour);
        p = findNamed(effect, ["Screen Gain"]); if (p) { p.setValue(100); }
        p = findNamed(effect, ["Screen Balance"]); if (p) { p.setValue(50); }
        // View remains at Keylight's default Final Result. No destructive matte choke.
        return effect;
    }
    function rectangleShape(x, y, w, h) {
        var s = new Shape();
        s.vertices = [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
        s.inTangents = [[0,0],[0,0],[0,0],[0,0]];
        s.outTangents = [[0,0],[0,0],[0,0],[0,0]];
        s.closed = true;
        return s;
    }
    function roundedShape(rect) {
        var x = rect[0], y = rect[1], w = rect[2], h = rect[3];
        var r = Math.min(rect[4] || 0, w/2, h/2), k = r*0.55228475;
        if (r <= 0) { return rectangleShape(x,y,w,h); }
        var s = new Shape();
        s.vertices = [[x+r,y],[x+w-r,y],[x+w,y+r],[x+w,y+h-r],
            [x+w-r,y+h],[x+r,y+h],[x,y+h-r],[x,y+r]];
        s.inTangents = [[-k,0],[0,0],[0,-k],[0,0],[k,0],[0,0],[0,k],[0,0]];
        s.outTangents = [[0,0],[k,0],[0,0],[0,k],[0,0],[-k,0],[0,0],[0,-k]];
        s.closed = true;
        return s;
    }
    function maskRectangle(layer, rect) {
        var mask = layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        mask.maskMode = MaskMode.ADD;
        mask.property("ADBE Mask Shape").setValue(roundedShape(rect));
        mask.property("ADBE Mask Feather").setValue([0,0]);
    }
    function importImage(file, folder) {
        var options = new ImportOptions(file);
        options.sequence = false;
        if (options.canImportAs(ImportAsType.FOOTAGE)) { options.importAs = ImportAsType.FOOTAGE; }
        var item = app.project.importFile(options);
        item.parentFolder = folder;
        return item;
    }
    function validateCrop(crop, source) {
        if (crop[0] < 0 || crop[1] < 0 || crop[2] < 4 || crop[3] < 4 ||
            crop[0]+crop[2] > source.width || crop[1]+crop[3] > source.height) {
            fail("Область вырезки выходит за границы скриншота.");
        }
    }
    function cropped(compName, source, part, folder) {
        var c = part.crop, i;
        validateCrop(c, source);
        var comp = app.project.items.addComp(compName, c[2], c[3], 1, CFG.duration, CFG.fps);
        comp.parentFolder = folder;
        var keyed = comp.layers.add(source);
        keyed.name = "SCREENSHOT_KEYLIGHT";
        tr(keyed).property("ADBE Anchor Point").setValue([0,0]);
        tr(keyed).property("ADBE Position").setValue([-c[0],-c[1]]);
        keyed.outPoint = CFG.duration;
        addKeylight(keyed);
        if (part.protect.length > 0) {
            var protectedLayer = comp.layers.add(source);
            protectedLayer.name = "ORIGINAL_COLOURS_INSIDE_CARDS";
            tr(protectedLayer).property("ADBE Anchor Point").setValue([0,0]);
            tr(protectedLayer).property("ADBE Position").setValue([-c[0],-c[1]]);
            protectedLayer.outPoint = CFG.duration;
            for (i = 0; i < part.protect.length; i++) { maskRectangle(protectedLayer, part.protect[i]); }
            protectedLayer.comment = "Unkeyed card interiors restore original colours, including green photo details. Masks use original source pixels.";
        }
        return comp;
    }
    function validateWordTiming(spec, highlightNumber) {
        if (!voice) { fail("Для wordTiming нужна начитка."); }
        if (!(spec.wordTiming instanceof Array) || spec.wordTiming.length !== spec.rows.length) {
            fail("Число строк wordTiming должно совпадать с rows в выделении " + highlightNumber + ".");
        }
        var previousEnd = voice.startFrame / CFG.fps;
        var audioEnd = previousEnd + voice.duration;
        var i, j, words, word, previousWidth, rowWidth;
        for (i = 0; i < spec.rows.length; i++) {
            words = spec.wordTiming[i];
            rowWidth = spec.rows[i][2];
            previousWidth = 0;
            if (!(words instanceof Array) || !words.length) { fail("Нет тайминга слов в строке " + (i+1) + "."); }
            for (j = 0; j < words.length; j++) {
                word = words[j];
                if (!(word instanceof Array) || word.length !== 3 ||
                    typeof word[0] !== "number" || !isFinite(word[0]) ||
                    typeof word[1] !== "number" || !isFinite(word[1]) ||
                    typeof word[2] !== "number" || !isFinite(word[2]) ||
                    word[0] < previousEnd || word[1] <= word[0] || word[1] > audioEnd + 0.00001 ||
                    word[2] <= previousWidth || word[2] > rowWidth) {
                    fail("Неверные время или граница слова " + (j+1) + " в строке " + (i+1) + ".");
                }
                previousEnd = word[1];
                previousWidth = word[2];
            }
            if (previousWidth !== rowWidth) { fail("Последнее слово должно раскрывать всю строку " + (i+1) + "."); }
        }
    }
    function revealWithVoice(layer, rowWidth, words) {
        var scale = requiredProperty(tr(layer), "ADBE Scale");
        var previousWidth = 0, i, word;
        layer.inPoint = words[0][0];
        for (i = 0; i < words.length; i++) {
            word = words[i];
            scale.setValueAtTime(word[0], [100 * previousWidth / rowWidth, 100]);
            scale.setValueAtTime(word[1], [100 * word[2] / rowWidth, 100]);
            previousWidth = word[2];
        }
        for (i = 1; i <= scale.numKeys; i++) {
            scale.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        }
    }
    function addHighlights(comp, crop) {
        var i, j, spec, row, totalWidth, elapsed, rowDuration, layer, contents, path, fill, y, h;
        for (i = 0; i < HIGHLIGHTS.length; i++) {
            spec = HIGHLIGHTS[i]; totalWidth = 0; elapsed = 0;
            for (j = 0; j < spec.rows.length; j++) {
                row = spec.rows[j];
                if (row[2] <= 0 || row[3] <= 0 || row[0] < crop[0] || row[1] < crop[1] ||
                    row[0]+row[2] > crop[0]+crop[2] || row[1]+row[3] > crop[1]+crop[3]) {
                    fail("Область выделения выходит за границы ленты.");
                }
                totalWidth += row[2];
            }
            for (j = 0; j < spec.rows.length; j++) {
                row = spec.rows[j]; y = row[1]-crop[1]; h = row[3];
                if (spec.mode === "underline") { h = spec.thickness || 5; y += row[3]-h; }
                layer = comp.layers.addShape();
                layer.name = "MARK_" + (i+1) + "_LINE_" + (j+1);
                layer.comment = spec.text || "User-selected phrase";
                contents = layer.property("ADBE Root Vectors Group");
                path = contents.addProperty("ADBE Vector Shape - Group");
                path.property("ADBE Vector Shape").setValue(rectangleShape(0,0,row[2],h));
                fill = contents.addProperty("ADBE Vector Graphic - Fill");
                fill.property("ADBE Vector Fill Color").setValue(spec.color || [1,1,0]);
                tr(layer).property("ADBE Anchor Point").setValue([0,0]);
                tr(layer).property("ADBE Position").setValue([row[0]-crop[0],y]);
                tr(layer).property("ADBE Opacity").setValue(typeof spec.opacity === "number" ? spec.opacity : 100);
                layer.blendingMode = BlendingMode.MULTIPLY;
                layer.outPoint = CFG.duration;
                if (spec.wordTiming) {
                    revealWithVoice(layer, row[2], spec.wordTiming[j]);
                } else {
                    rowDuration = spec.duration * row[2] / totalWidth;
                    layer.inPoint = spec.start + elapsed;
                    animate(tr(layer).property("ADBE Scale"), spec.start+elapsed,
                        spec.start+elapsed+rowDuration, [0,100], [100,100], false);
                    elapsed += rowDuration;
                }
            }
        }
    }
    function addShadow(layer) {
        if (!CFG.shadow.enabled) { return; }
        var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
        fx.property("ADBE Drop Shadow-0002").setValue(CFG.shadow.opacity);
        fx.property("ADBE Drop Shadow-0004").setValue(CFG.shadow.distance);
        fx.property("ADBE Drop Shadow-0005").setValue(CFG.shadow.softness);
    }
    function placeCard(scene, source, part, name) {
        var layer = scene.layers.add(source);
        layer.name = name;
        layer.motionBlur = CFG.motionBlur;
        var factor = part.width / source.width;
        var offsetX = (scene.width-CFG.width)/2;
        var offsetY = (scene.height-CFG.height)/2;
        tr(layer).property("ADBE Scale").setValue([factor*100,factor*100]);
        tr(layer).property("ADBE Position").setValue([part.center[0]+offsetX,part.center[1]+offsetY]);
        addShadow(layer);
        return layer;
    }
    function addScenePlane(main, file, assets, precomps) {
        var overscan = CFG.sceneOverscan;
        if (typeof overscan !== "number") {
            var legacyOverscan = (CFG.background3D || {}).overscan;
            overscan = typeof legacyOverscan === "number" ? legacyOverscan : 1.25;
        }
        var minimumMagnification = Math.min(CFG.camera.startMagnification, CFG.camera.endMagnification);
        if (!isFinite(overscan) || overscan < 1 || !(CFG.camera.zoom > 0) || !(minimumMagnification > 0)) {
            fail("Неверный запас размера общей плоскости или масштаб камеры.");
        }
        var size = Math.max(1, 1/minimumMagnification)*overscan;
        var scene = app.project.items.addComp("TELEGRAM_SHARED_PLANE", Math.ceil(CFG.width*size),
            Math.ceil(CFG.height*size), 1, CFG.duration, CFG.fps);
        scene.parentFolder = precomps;
        scene.motionBlur = CFG.motionBlur;
        scene.shutterAngle = main.shutterAngle;
        var source = importImage(file, assets);
        var background = scene.layers.add(source);
        background.name = "TELEGRAM_BACKGROUND";
        var cover = 100*Math.max(scene.width/source.width, scene.height/source.height);
        requiredProperty(tr(background), "ADBE Scale").setValue([cover,cover]);
        var plane = main.layers.add(scene);
        plane.name = "TELEGRAM_SHARED_3D_PLANE";
        plane.threeDLayer = true;
        plane.motionBlur = CFG.motionBlur;
        plane.collapseTransformation = false;
        plane.comment = "Background, feed and profile share one plane. Scroll is animated inside the precomp.";
        return scene;
    }
    function addSceneBlur(main, assets) {
        var config = CFG.sceneBlur || {};
        if (config.enabled === false) { return; }
        var radiusAt1080 = typeof config.radius === "number" ? config.radius : 4;
        var clearAt = typeof config.clearAt === "number" ? config.clearAt : CFG.feed.scrollEnd;
        var holdUntil = typeof config.holdUntil === "number" ? config.holdUntil : Math.max(0, clearAt-0.9);
        if (radiusAt1080 < 0 || holdUntil < 0 || clearAt <= holdUntil || clearAt > CFG.duration) {
            fail("Неверный тайминг Camera Lens Blur: нужны начальное размытие и плавный переход к нулю внутри сцены.");
        }
        var layer = main.layers.addSolid([1,1,1], "SCENE_CAMERA_LENS_BLUR", CFG.width, CFG.height, 1, CFG.duration);
        layer.source.parentFolder = assets;
        layer.adjustmentLayer = true;
        layer.threeDLayer = false;
        layer.outPoint = CFG.duration;
        var effects = requiredProperty(layer, "ADBE Effect Parade");
        if (!effects.canAddProperty("ADBE Camera Lens Blur")) { fail("Эффект Camera Lens Blur не найден в этой установке AE."); }
        var effect = effects.addProperty("ADBE Camera Lens Blur");
        var radius = requiredProperty(effect, "ADBE Camera Lens Blur-0001");
        var initialRadius = radiusAt1080 * CFG.width / 1920;
        radius.setValueAtTime(0, initialRadius);
        animate(radius, holdUntil, clearAt, initialRadius, 0, true);
        layer.comment = "Camera Lens Blur over the complete scene from frame zero. Radius reaches zero at scroll end; native camera DOF remains separate.";
    }
    function addCamera(main) {
        var rig = main.layers.addNull(CFG.duration);
        rig.name = "CAMERA_RIG_EDIT_MOVEMENT"; rig.threeDLayer = true;
        tr(rig).property("ADBE Anchor Point").setValue([0,0,0]);
        tr(rig).property("ADBE Position").setValue([CFG.width/2,CFG.height/2,0]);
        // The shared plane turns around the vertical axis through the final hold.
        animate(requiredProperty(tr(rig), "ADBE Rotate Y"), 0, CFG.duration,
            startRotation[1], endRotation[1], true);
        var camera = main.layers.addCamera("CAMERA_3D", [CFG.width/2,CFG.height/2]);
        // Keep local transforms; Position and Point of Interest are set below.
        camera.setParentWithJump(rig);
        camera.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
        var cameraTransform = tr(camera);
        // A camera's Point of Interest uses the ADBE Anchor Point match name.
        requiredProperty(cameraTransform, "ADBE Anchor Point").setValue([0,0,0]);
        animate(requiredProperty(cameraTransform, "ADBE Position"), 0, CFG.duration,
            [0,0,-CFG.camera.zoom/CFG.camera.startMagnification],
            [0,0,-CFG.camera.zoom/CFG.camera.endMagnification], true);
        var options = requiredProperty(camera, "ADBE Camera Options Group");
        requiredProperty(options, "ADBE Camera Zoom").setValue(CFG.camera.zoom);
        requiredProperty(options, "ADBE Camera Depth of Field").setValue(CFG.camera.depthOfField ? 1 : 0);
        requiredProperty(options, "ADBE Camera Aperture").setValue(CFG.camera.aperture);
        requiredProperty(options, "ADBE Camera Blur Level").setValue(CFG.camera.blurLevel);
        requiredProperty(options, "ADBE Camera Focus Distance").expression = "length(transform.position, transform.pointOfInterest)";
        camera.comment = "Native two-node 3D camera. Dolly keys on Position; orbit keys on parent CAMERA_RIG. DOF disabled initially for text clarity.";
    }

    var startRotation, endRotation;
    try {
        if (!CFG.camera) { fail("В shot.jsxinc отсутствуют настройки камеры."); }
        if (!(HIGHLIGHTS instanceof Array)) { fail("Поле highlights должно быть массивом."); }
        startRotation = typeof CFG.camera.startRotation === "undefined" ? [0,-12,0] : CFG.camera.startRotation;
        endRotation = typeof CFG.camera.endRotation === "undefined" ? [0,12,0] : CFG.camera.endRotation;
        var rotations = [startRotation, endRotation];
        for (var rotationIndex = 0; rotationIndex < rotations.length; rotationIndex++) {
            var rotation = rotations[rotationIndex];
            if (!(rotation instanceof Array) || rotation.length !== 3 || rotation[0] !== 0 || rotation[2] !== 0 ||
                typeof rotation[1] !== "number" || !isFinite(rotation[1])) {
                fail("Камера поворачивается только по Y. Укажите углы в формате [0, угол Y, 0].");
            }
        }
        if (voice) {
            if (voice.startFrame !== 15) { fail("Начитка должна начинаться на кадре 15, нумерация от нуля."); }
            if (typeof voice.file !== "string" || !voice.file || typeof voice.duration !== "number" ||
                !isFinite(voice.duration) || voice.duration <= 0 || voice.startFrame / CFG.fps + voice.duration + 1 > CFG.duration + 0.00001) {
                fail("Укажите файл и полную длительность начитки. После неё нужна секунда тишины.");
            }
        }
        for (var highlightIndex = 0; highlightIndex < HIGHLIGHTS.length; highlightIndex++) {
            var spec = HIGHLIGHTS[highlightIndex];
            var highlightNumber = highlightIndex+1;
            if (!spec || !(spec.rows instanceof Array) || !spec.rows.length) { fail("Нет строк в выделении " + highlightNumber + "."); }
            if (spec.wordTiming) {
                validateWordTiming(spec, highlightNumber);
            } else if (voice) {
                fail("Для выделения " + highlightNumber + " при начитке обязателен пословный тайминг wordTiming.");
            } else if (typeof spec.start !== "number" || !isFinite(spec.start) || typeof spec.duration !== "number" ||
                !isFinite(spec.duration) || spec.duration <= 0 || spec.start < 0 || spec.start + spec.duration > CFG.duration) {
                fail("Неверный тайминг выделения " + highlightNumber + ".");
            }
        }
    } catch (validationError) { reportError(validationError.message); return; }

    var screenshotFile = fileAt(CFG.screenshot);
    if (!screenshotFile.exists) { reportError("Не найден assets/feed_green.png. Распакуйте пакет полностью."); return; }
    var backgroundFile = fileAt(CFG.background || "assets/telegram_background.png");
    if (!backgroundFile.exists) { reportError("Не найден постоянный фон assets/telegram_background.png. Скопируйте его из шаблона репозитория вместе с пакетом."); return; }

    app.beginUndoGroup("Build Telegram 3D Keylight");
    try {
        if (!app.project) { app.newProject(); }
        var root = app.project.items.addFolder(CFG.name);
        var assets = app.project.items.addFolder("ASSETS"); assets.parentFolder = root;
        var precomps = app.project.items.addFolder("SOURCES_KEYLIGHT_AND_MARKS"); precomps.parentFolder = root;
        var screenshot = importImage(screenshotFile, assets);
        if (screenshot.width !== CFG.expectedWidth || screenshot.height !== CFG.expectedHeight) {
            fail("Размер PNG не совпадает с разметкой shot.jsxinc. Подготовьте конфигурацию под этот исходник.");
        }
        var main = app.project.items.addComp(CFG.name + "_MASTER", CFG.width, CFG.height, 1, CFG.duration, CFG.fps);
        main.parentFolder = root;
        // Historical scripting ID for the Classic 3D renderer; use only if available.
        var renderers = main.renderers, ri;
        for (ri = 0; ri < renderers.length; ri++) {
            if (renderers[ri] === "ADBE Advanced 3d") { main.renderer = renderers[ri]; break; }
        }
        main.motionBlur = CFG.motionBlur;
        main.shutterAngle = 180;
        var scene = addScenePlane(main, backgroundFile, assets, precomps);
        var feedComp = cropped("FEED_KEYLIGHT_AND_MARKS", screenshot, CFG.feed, precomps);
        addHighlights(feedComp, CFG.feed.crop);
        var feed = placeCard(scene, feedComp, CFG.feed, CFG.feed.scrollEnabled === false ? "POST_STATIC" : "FEED_SCROLL");
        tr(feed).property("ADBE Anchor Point").setValue([feedComp.width/2,0]);
        var factor = CFG.feed.width/feedComp.width;
        var feedPosition = tr(feed).property("ADBE Position");
        var center = feedPosition.value;
        var targetPosition = [center[0],center[1]-CFG.feed.endFocusY*factor];
        if (CFG.feed.scrollEnabled === false) {
            feedPosition.setValue(targetPosition);
        } else {
            animate(feedPosition, CFG.feed.scrollStart, CFG.feed.scrollEnd,
                [center[0],center[1]-CFG.feed.startFocusY*factor],
                targetPosition, true, scrollEase);
        }
        if (CFG.profile.enabled) {
            var profileComp = cropped("PROFILE_KEYLIGHT", screenshot, CFG.profile, precomps);
            placeCard(scene, profileComp, CFG.profile, "PROFILE_CARD");
        }
        addCamera(main);
        var voiceMeta = null;
        if (voice) {
            var voiceFile = fileAt(voice.file);
            if (!voiceFile.exists) { fail("Не найден файл начитки: " + voice.file); }
            var voiceSource = app.project.importFile(new ImportOptions(voiceFile));
            if (!voiceSource.hasAudio) { fail("В файле начитки нет звуковой дорожки."); }
            voiceSource.parentFolder = assets;
            var voiceLayer = main.layers.add(voiceSource);
            voiceLayer.name = "VOICEOVER_START_FRAME_" + voice.startFrame;
            voiceLayer.startTime = voice.startFrame / CFG.fps;
            voiceLayer.inPoint = voiceLayer.startTime;
            voiceLayer.outPoint = voiceLayer.startTime + voice.duration;
            var actualStartFrame = voiceLayer.inPoint / main.frameDuration;
            if (Math.abs(actualStartFrame - 15) > 0.00001) { fail("В композиции начитка должна начинаться на кадре 15."); }
            voiceMeta = {file:voiceFile.fsName, startFrame:Math.round(actualStartFrame), duration:voice.duration};
        }
        // This 2D adjustment layer is above all 3D scene layers, including the background.
        addSceneBlur(main, assets);
        main.comment = "Telegram AE template version " + templateVersion + ". Built from a measured shot.jsxinc.";
        if (CFG.feed.scrollEnabled === false) {
            main.markerProperty.setValueAtTime(0, new MarkerValue("STATIC_POST_NO_SCROLL"));
        } else {
            main.markerProperty.setValueAtTime(CFG.feed.scrollEnd, new MarkerValue("SCROLL_END"));
        }
        if (HIGHLIGHTS.length === 0) {
            main.markerProperty.setValueAtTime(3, new MarkerValue("NO_HIGHLIGHTS_CONFIGURED"));
        }
        main.workAreaStart = 0; main.workAreaDuration = CFG.duration; main.time = 0;
        if (unattended) { $.global.TELEGRAM_AE_RESULT = {main: main, root: root, audio: voiceMeta, templateVersion: templateVersion}; }
        else { main.openInViewer(); }
    } catch (error) {
        reportError("Не удалось завершить сборку.\n" + error.toString() + "\nСтрока: " + error.line +
            "\nСозданные элементы можно отменить одной операцией Undo.");
    } finally { app.endUndoGroup(); }
}());
