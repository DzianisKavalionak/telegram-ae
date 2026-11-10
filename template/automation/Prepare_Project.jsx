#target aftereffects
/* Run only in the dedicated AfterFX process launched by Render_Telegram.ps1. */
(function () {
    $.writeln('TELEGRAM_AE_WORKER_STARTED');
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
    var descriptorPath = $.getenv('TELEGRAM_AE_JOB_PATH');
    if (!descriptorPath) { throw new Error('Use Render_Telegram.ps1 to start an isolated job.'); }
    var job = $.evalFile(new File(descriptorPath));
    if (!job || job.token !== $.getenv('TELEGRAM_AE_JOB_TOKEN')) {
        throw new Error('Isolated job token mismatch; current AE project has not been changed.');
    }
    app.exitAfterLaunchAndEval = true;
    app.exitCode = 1;
    app.beginSuppressDialogs();
    try {
        app.setSavePreferencesOnQuit(false);
        app.newProject();
        $.global.TELEGRAM_AE_AUTOMATION = true;
        $.global.TELEGRAM_AE_RESULT = null;
        $.evalFile(new File(job.builderPath));
        var result = $.global.TELEGRAM_AE_RESULT;
        if (!result || !result.main) { throw new Error('Scene builder did not return its main composition.'); }
        var main = result.main, i, item;
        main.resolutionFactor = [1,1];
        for (i = 1; i <= app.project.numItems; i++) {
            item = app.project.item(i);
            if (item instanceof FootageItem && item.file && item.footageMissing) {
                throw new Error('Missing footage: ' + item.file.fsName);
            }
        }
        var rq = app.project.renderQueue.items.add(main);
        var rsTemplates = list(rq.templates);
        for (i = 0; i < rsTemplates.length; i++) {
            if (rsTemplates[i] === 'Best Settings') { rq.applyTemplate(rsTemplates[i]); break; }
        }
        rq.timeSpanStart = 0; rq.timeSpanDuration = main.duration; rq.skipFrames = 0;
        var om = rq.outputModule(1), templates = list(om.templates), selected = null;
        for (i = 0; i < templates.length; i++) {
            if (templates[i] === 'Lossless' || templates[i] === job.outputTemplate) { selected = templates[i]; break; }
        }
        if (!selected) { throw new Error('Lossless output template unavailable. Available: ' + templates.join(', ')); }
        om.applyTemplate(selected);
        om.file = new File(job.intermediatePath);
        var outputSettings = om.getSettings(GetSettingsFormat.STRING);
        if (String(outputSettings.Format).toUpperCase() !== 'AVI') {
            throw new Error('Expected AVI from Lossless template; got ' + outputSettings.Format);
        }
        app.project.save(new File(job.projectPath));
        write(job.resultPath, {
            status: 'ready', aeVersion: String(app.version), project: job.projectPath,
            comp: main.name, width: main.width, height: main.height,
            fps: main.frameRate, duration: main.duration, audio: result.audio || null,
            frames: Math.round(main.duration * main.frameRate), rqIndex: app.project.renderQueue.numItems,
            outputTemplate: selected, outputFormat: outputSettings.Format,
            availableOutputTemplates: templates
        });
        app.exitCode = 0;
    } catch (error) {
        try { write(job.resultPath, {status:'failed',error:String(error),line:error.line}); }
        catch (writeError) { $.writeln(String(error) + ' / ' + String(writeError)); }
        app.exitCode = 1;
    } finally {
        $.global.TELEGRAM_AE_AUTOMATION = false;
        app.endSuppressDialogs(false);
        // The inherited token above proves this is our isolated worker instance.
        if (app.project) { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); }
        app.quit();
    }
}());
