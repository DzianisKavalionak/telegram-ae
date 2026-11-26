#target aftereffects
/* Build and render one job inside the dedicated AfterFX process. */
(function () {
    function quote(s) {
        return '"' + String(s).replace(/[\\"\u0000-\u001f]/g, function (c) {
            if (c === '\\') { return '\\\\'; }
            if (c === '"') { return '\\"'; }
            return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }
    function json(value) {
        var i, parts = [];
        if (value === null || typeof value === "undefined") { return "null"; }
        if (typeof value === "string") { return quote(value); }
        if (typeof value === "number" || typeof value === "boolean") { return String(value); }
        if (value instanceof Array) {
            for (i = 0; i < value.length; i++) { parts.push(json(value[i])); }
            return '[' + parts.join(',') + ']';
        }
        for (i in value) { if (value.hasOwnProperty(i)) { parts.push(quote(i) + ':' + json(value[i])); } }
        return '{' + parts.join(',') + '}';
    }
    function write(filePath, value) {
        var file = new File(filePath); file.encoding = "UTF-8";
        if (!file.open('w')) { throw new Error('Cannot write job status: ' + filePath); }
        file.write(json(value)); file.close();
    }
    function list(values) {
        var result = [], i;
        for (i = 0; i < values.length; i++) { result.push(String(values[i])); }
        return result;
    }

    var token = $.getenv('TELEGRAM_AE_JOB_TOKEN');
    var job = $.global.TELEGRAM_AE_JOB;
    if (!token || !job || job.token !== token) { return; }

    function status(stage, error) {
        var value = {status: stage, token: token};
        if (error) { value.error = String(error); value.line = error.line; }
        write(job.statusPath, value);
    }

    if (app.project && (app.project.file || app.project.numItems > 0)) {
        status('failed', new Error('Isolated After Effects did not start with an empty project.'));
        return;
    }
    app.exitCode = 1;
    var suppressed = false, saved = false;
    try {
        app.setSavePreferencesOnQuit(false);
        app.beginSuppressDialogs();
        suppressed = true;
        status('building');

        var main, audio, i, item;
        if (job.resumeComp) {
            if (!app.open(new File(job.projectPath))) { throw new Error('Could not open saved AEP.'); }
            for (i = 1; i <= app.project.numItems; i++) {
                item = app.project.item(i);
                if (item instanceof CompItem && item.name === job.resumeComp) {
                    if (main) { throw new Error('Several compositions have the saved name: ' + job.resumeComp); }
                    main = item;
                }
            }
            if (!main) { throw new Error('Saved composition missing: ' + job.resumeComp); }
            audio = job.resumeAudio;
            saved = true;
        } else {
            if (!app.project && !app.newProject()) { throw new Error('Could not initialize a project.'); }
            $.global.TELEGRAM_AE_AUTOMATION = true;
            $.global.TELEGRAM_AE_RESULT = null;
            $.evalFile(new File(job.builderPath));
            var result = $.global.TELEGRAM_AE_RESULT;
            if (!result || !result.main) { throw new Error('Scene builder did not return its main composition.'); }
            if (result.templateVersion !== job.templateVersion) { throw new Error('Scene builder returned a mismatched template version.'); }
            main = result.main;
            audio = result.audio;
        }

        main.resolutionFactor = [1,1];
        for (i = 1; i <= app.project.numItems; i++) {
            item = app.project.item(i);
            if (item instanceof FootageItem && item.file && item.footageMissing) {
                throw new Error('Missing footage: ' + item.name);
            }
        }

        var queue = app.project.renderQueue;
        for (i = 1; i <= queue.numItems; i++) {
            if (queue.item(i).render) { queue.item(i).render = false; }
        }
        var entry = queue.items.add(main);
        var settingsTemplates = list(entry.templates);
        for (i = 0; i < settingsTemplates.length; i++) {
            if (settingsTemplates[i] === 'Best Settings') { entry.applyTemplate(settingsTemplates[i]); break; }
        }
        entry.timeSpanStart = 0;
        entry.timeSpanDuration = main.duration;
        entry.skipFrames = 0;

        var output = entry.outputModule(1), templates = list(output.templates), selected = 'TIFF Sequence with Alpha';
        var found = false;
        for (i = 0; i < templates.length; i++) {
            if (templates[i] === selected) { found = true; break; }
        }
        if (!found) { throw new Error('TIFF Sequence with Alpha is unavailable.'); }
        output.applyTemplate(selected);
        output.file = new File(job.outputPattern);

        if (!saved) { app.project.save(new File(job.projectPath)); }
        write(job.resultPath, {
            status: 'ready', aeVersion: String(app.version), project: job.projectPath,
            templateVersion: job.templateVersion,
            comp: main.name, width: main.width, height: main.height,
            fps: main.frameRate, duration: main.duration, audio: audio || null,
            frames: Math.round(main.duration * main.frameRate), rqIndex: queue.numItems,
            outputTemplate: selected, outputFormat: 'TIFF', availableOutputTemplates: templates
        });

        if (typeof app.setMultiFrameRenderingConfig === 'function') { app.setMultiFrameRenderingConfig(true, job.cpuPercent); }
        if (typeof app.setMemoryUsageLimits === 'function') { app.setMemoryUsageLimits(10,60); }
        status('rendering');
        queue.render();
        if (entry.status !== RQItemStatus.DONE) { throw new Error('Render queue did not report DONE: ' + entry.status); }
        status('done');
        app.exitCode = 0;
    } catch (error) {
        status('failed', error);
    } finally {
        $.global.TELEGRAM_AE_AUTOMATION = false;
        $.global.TELEGRAM_AE_RESULT = null;
        if (suppressed) { app.endSuppressDialogs(false); }
        // With no preferences saved, the dedicated process can exit without changing the active AE.
        if (app.project) { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); }
        app.quit();
    }
}());
