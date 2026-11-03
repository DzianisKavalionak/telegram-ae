#target aftereffects
/* ExtendScript ES3. Reusable Telegram scene builder.
   Reads a prepared shot.jsxinc next to this script.
   No automatic save, render, project close or application launch. */
(function () {
    var base = new File($.fileName).parent;
    var configFile = new File(base.fsName + "/shot.jsxinc");
    if (!configFile.exists) {
        alert("Не найден shot.jsxinc. Нужна разметка конкретного скриншота по правилам репозитория.");
        return;
    }
    var shot;
    try { shot = $.evalFile(configFile); }
    catch (configError) { alert("Ошибка чтения shot.jsxinc: " + configError.toString()); return; }
    if (!shot || !shot.settings) { alert("shot.jsxinc должен вернуть settings и highlights."); return; }
    var CFG = shot.settings;
    var HIGHLIGHTS = shot.highlights || [];
    if (CFG.mappingStatus !== "measured") {
        alert("Это пример конфигурации. Сначала разметьте новый скриншот и подготовьте shot.jsxinc со статусом measured.");
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
    function smooth(prop) {
        if (prop.numKeys < 2) { return; }
        var count = prop.keyInTemporalEase(1).length;
        var k, j, incoming, outgoing;
        for (k = 1; k <= prop.numKeys; k++) {
            incoming = []; outgoing = [];
            for (j = 0; j < count; j++) {
                incoming.push(new KeyframeEase(0, 65));
                outgoing.push(new KeyframeEase(0, 65));
            }
            prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            prop.setTemporalEaseAtKey(k, incoming, outgoing);
        }
    }
    function animate(prop, begin, end, first, last, eased) {
        prop.setValueAtTime(begin, first);
        prop.setValueAtTime(end, last);
        if (eased) { smooth(prop); }
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
    function addHighlights(comp, crop) {
        var i, j, spec, row, totalWidth, elapsed, rowDuration, layer, contents, path, fill, y, h;
        for (i = 0; i < HIGHLIGHTS.length; i++) {
            spec = HIGHLIGHTS[i]; totalWidth = 0; elapsed = 0;
            if (!spec.rows || spec.rows.length === 0 || spec.duration <= 0 || spec.start < 0 ||
                spec.start + spec.duration > CFG.duration) { fail("Неверный тайминг выделения " + (i+1)); }
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
                rowDuration = spec.duration * row[2] / totalWidth;
                layer.inPoint = spec.start + elapsed;
                layer.outPoint = CFG.duration;
                animate(tr(layer).property("ADBE Scale"), spec.start+elapsed,
                    spec.start+elapsed+rowDuration, [0,100], [100,100], false);
                elapsed += rowDuration;
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
    function place3D(main, source, part, name) {
        var layer = main.layers.add(source);
        layer.name = name;
        layer.threeDLayer = true;
        layer.motionBlur = CFG.motionBlur;
        var factor = part.width / source.width;
        tr(layer).property("ADBE Scale").setValue([factor*100,factor*100,factor*100]);
        tr(layer).property("ADBE Position").setValue(part.center);
        addShadow(layer);
        return layer;
    }
    function addCamera(main) {
        var rig = main.layers.addNull(CFG.duration);
        rig.name = "CAMERA_RIG_EDIT_MOVEMENT"; rig.threeDLayer = true;
        tr(rig).property("ADBE Anchor Point").setValue([0,0,0]);
        tr(rig).property("ADBE Position").setValue([CFG.width/2,CFG.height/2,0]);
        var names = ["ADBE Rotate X","ADBE Rotate Y","ADBE Rotate Z"], i;
        for (i = 0; i < names.length; i++) {
            animate(tr(rig).property(names[i]), 0, CFG.duration,
                CFG.camera.startRotation[i], CFG.camera.endRotation[i], true);
        }
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

    var screenshotFile = fileAt(CFG.screenshot);
    if (!screenshotFile.exists) { alert("Не найден assets/feed_green.png. Распакуйте пакет полностью."); return; }
    var backgroundFile = fileAt(CFG.background || "assets/telegram_background.png");
    if (!backgroundFile.exists) { alert("Не найден постоянный фон assets/telegram_background.png. Скопируйте его из шаблона репозитория вместе с пакетом."); return; }

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
        if (backgroundFile) {
            var bgSource = importImage(backgroundFile, assets);
            var bg = main.layers.add(bgSource);
            bg.name = "BACKGROUND_REPLACE_HERE"; bg.outPoint = CFG.duration;
            var cover = 100 * Math.max(CFG.width/bgSource.width, CFG.height/bgSource.height);
            tr(bg).property("ADBE Scale").setValue([cover,cover]);
            tr(bg).property("ADBE Position").setValue([CFG.width/2,CFG.height/2]);
        }
        var feedComp = cropped("FEED_KEYLIGHT_AND_MARKS", screenshot, CFG.feed, precomps);
        addHighlights(feedComp, CFG.feed.crop);
        var feed = place3D(main, feedComp, CFG.feed, "FEED_3D_SCROLL");
        tr(feed).property("ADBE Anchor Point").setValue([feedComp.width/2,0,0]);
        var factor = CFG.feed.width/feedComp.width;
        animate(tr(feed).property("ADBE Position"), CFG.feed.scrollStart, CFG.feed.scrollEnd,
            [CFG.feed.center[0],CFG.feed.center[1]-CFG.feed.startFocusY*factor,CFG.feed.center[2]],
            [CFG.feed.center[0],CFG.feed.center[1]-CFG.feed.endFocusY*factor,CFG.feed.center[2]],true);
        if (CFG.profile.enabled) {
            var profileComp = cropped("PROFILE_KEYLIGHT", screenshot, CFG.profile, precomps);
            place3D(main, profileComp, CFG.profile, "PROFILE_3D");
        }
        addCamera(main);
        main.comment = "Built from a measured shot.jsxinc using telegram-ae. Generation alone does not confirm AE execution or render review.";
        main.markerProperty.setValueAtTime(CFG.feed.scrollEnd, new MarkerValue("SCROLL_END"));
        if (HIGHLIGHTS.length === 0) {
            main.markerProperty.setValueAtTime(3, new MarkerValue("NO_HIGHLIGHTS_CONFIGURED"));
        }
        main.workAreaStart = 0; main.workAreaDuration = CFG.duration; main.time = 0;
        main.openInViewer();
    } catch (error) {
        alert("Не удалось завершить сборку.\n" + error.toString() + "\nСтрока: " + error.line +
            "\nСозданные элементы можно отменить одной операцией Undo.");
    } finally { app.endUndoGroup(); }
}());
