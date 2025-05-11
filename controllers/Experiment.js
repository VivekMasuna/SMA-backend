const Experiment = require('../models/Experiment');
const { exec, spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const isProduction = process.env.NODE_ENV === "production";

const PYTHON_CMD = isProduction
    ? "/var/www/vhosts/kjsieit.com/sma-vlab-backend.kjsieit.com/venv/bin/python"
    : (() => {
        try {
            const path = require("child_process")
                .execSync(process.platform === "win32" ? "where python" : "which python")
                .toString().split("\n")[0].trim();
            console.log(`Python path found: ${path}`);
            return path;
        } catch (err) {
            console.warn('Failed to detect Python path, falling back to "python"');
            return "python";
        }
    })();

module.exports.experiment = async (req, res) => {
    try {
        const experimentNo = parseInt(req.params.no, 10);
        logger.info(`Fetching experiment number: ${experimentNo}`);
        if (isNaN(experimentNo)) {
            logger.warn('Invalid experiment number received');
            return res.status(400).json({ error: "Invalid experiment number" });
        }

        const experiment = await Experiment.findOne({ no: experimentNo });
        if (!experiment) {
            logger.warn(`Experiment ${experimentNo} not found`);
            const allExperiments = await Experiment.find({}, { no: 1, title: 1 }).sort({ no: 1 });
            return res.status(404).json({
                error: "Experiment not found",
                message: `No experiment found with number ${experimentNo}`,
                availableExperiments: allExperiments
            });
        }

        logger.info(`Experiment ${experimentNo} found`);
        res.json(experiment);
    } catch (error) {
        logger.error("Error fetching experiment:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

module.exports.sentimentCSV = (req, res) => {
    let filePath;

    if (req.body.filename) {
        filePath = path.join(__dirname, '..', 'uploads', req.body.filename);
    } else if (req.body.datasetName) {
        filePath = path.join(__dirname, '..', 'datasets', req.body.datasetName);
    } else if (req.file) {
        filePath = path.join(__dirname, '..', 'uploads', req.file.filename);
    } else {
        logger.warn('No input file provided');
        return res.status(400).json({ error: 'No input file provided.' });
    }

    logger.info(`Processing file: ${filePath}`);

    if (!fs.existsSync(filePath)) {
        logger.warn(`File not found: ${filePath}`);
        return res.status(404).json({ error: 'File not found.' });
    }

    if (!filePath.endsWith('.csv')) {
        logger.warn(`Invalid file type (not CSV): ${filePath}`);
        return res.status(400).json({ error: 'Only CSV files are supported.' });
    }

    const pythonScript = path.join(__dirname, '..', 'python_scripts', 'sentiment_analysis.py');

    exec(`${PYTHON_CMD} "${pythonScript}" "${filePath}"`, (error, stdout, stderr) => {
        if (error || stderr) {
            logger.error('Python script execution error', { error: error?.message, stderr });
            return res.status(500).json({
                error: 'Python script execution failed.',
                details: stderr || error.message,
            });
        }

        try {
            const output = JSON.parse(stdout);
            logger.info('Sentiment analysis (CSV) complete');
            return res.status(200).json({ message: 'Analysis complete.', output });
        } catch (parseError) {
            logger.error('Failed to parse Python output (CSV)', { stdout });
            return res.status(500).json({
                error: 'Invalid JSON output from Python script.',
                raw: stdout,
            });
        }
    });
};

module.exports.sentimentText = (req, res) => {
    const { text } = req.body;
    if (!text) {
        logger.warn('No text provided for sentiment analysis');
        return res.status(400).json({ error: 'No text provided' });
    }

    const pythonScript = path.join(__dirname, '..', 'python_scripts', 'sentiment_analysis_text.py');
    const safeText = text.replace(/"/g, '\\"');

    logger.info('Running sentiment analysis on text input');

    exec(`${PYTHON_CMD} "${pythonScript}" "${safeText}"`, (error, stdout, stderr) => {
        if (error) {
            logger.error('Python script execution error (text)', { error: error.message });
            return res.status(500).json({ error: error.message });
        }

        try {
            const output = JSON.parse(stdout);
            logger.info('Sentiment analysis (text) complete');
            res.status(200).json({ message: 'Analysis complete', output });
        } catch (e) {
            logger.error('Failed to parse Python output (text)');
            res.status(500).json({ error: 'Error parsing output' });
        }
    });
};

module.exports.sentimentMulti = (req, res) => {
    const inputData = req.body.data;

    if (!inputData || !Array.isArray(inputData)) {
        logger.warn('Expected an array of text entries for multi sentiment analysis');
        return res.status(400).json({ error: 'Expected an array of text entries.' });
    }

    for (let i = 0; i < inputData.length; i++) {
        const entry = inputData[i];
        if (typeof entry.text !== 'string' || entry.text.trim() === '') {
            logger.warn(`Entry ${i + 1} is missing a valid 'text' field`);
            return res.status(400).json({ error: `Entry ${i + 1} is missing a valid 'text' field.` });
        }
        if (entry.label && !['positive', 'neutral', 'negative'].includes(entry.label)) {
            logger.warn(`Invalid label at entry ${i + 1}`);
            return res.status(400).json({ error: `Invalid label at entry ${i + 1}.` });
        }
    }

    const pythonScript = path.join(__dirname, '..', 'python_scripts', 'sentiment_analysis_multi.py');
    const pythonProcess = spawn(PYTHON_CMD, [pythonScript]);

    logger.info('Running sentiment analysis on multiple entries');

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', data => stdout += data.toString());
    pythonProcess.stderr.on('data', data => stderr += data.toString());

    pythonProcess.on('close', code => {
        if (code !== 0 || stderr) {
            logger.error('Python script execution failed (multi)', { code, stderr });
            return res.status(500).json({ error: 'Python script execution failed.', stderr, code });
        }

        try {
            const parsed = JSON.parse(stdout);
            logger.info('Sentiment analysis (multi) complete');
            res.status(200).json({ output: parsed });
        } catch (e) {
            logger.error('Failed to parse Python output (multi)', { raw: stdout });
            res.status(500).json({ error: 'Failed to parse Python output.', raw: stdout });
        }
    });

    pythonProcess.stdin.write(JSON.stringify(inputData));
    pythonProcess.stdin.end();
};

module.exports.defaultDatasets = (req, res) => {
    const datasetDir = path.join(__dirname, '..', 'datasets');

    if (!fs.existsSync(datasetDir)) {
        logger.warn('Dataset folder not found');
        return res.status(400).json({ error: 'Dataset folder not found.' });
    }

    fs.readdir(datasetDir, (err, files) => {
        if (err) {
            logger.error('Failed to read datasets folder', { error: err.message });
            return res.status(500).json({ error: 'Failed to read datasets folder.' });
        }

        const csvFiles = files.filter(file => file.endsWith('.csv'));
        if (!csvFiles.length) {
            logger.warn('No CSV datasets found');
            return res.status(404).json({ error: 'No CSV datasets found.' });
        }

        logger.info(`Found ${csvFiles.length} datasets`);
        res.status(200).json({ datasets: csvFiles });
    });
};

module.exports.runTopicModeling = (req, res) => {
    if (!req.file) {
        logger.warn('No file uploaded for topic modeling');
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = path.join(__dirname, '..', 'uploads', req.file.filename);
    const numTopics = req.body.numTopics || 5;
    const pythonScript = path.join(__dirname, '..', 'python_scripts', 'topic_modeling.py');

    logger.info(`Running topic modeling on file: ${filePath}`);

    exec(`"${PYTHON_CMD}" "${pythonScript}" "${filePath}" "${numTopics}"`, (error, stdout, stderr) => {
        logger.error('[SERVER] STDERR:', stderr);
        if (error) logger.error('[SERVER] ERROR:', error.message);

        if (error) {
            return res.status(500).json({
                error: 'Python script execution failed',
                detail: stderr || error.message,
            });
        }

        if (!stdout || stdout.trim() === '') {
            logger.error('Python script returned empty output (topic modeling)');
            return res.status(500).json({
                error: 'Python script returned empty output',
            });
        }

        try {
            const jsonRegex = /({[\s\S]*})/;
            const match = stdout.match(jsonRegex);
            if (!match) throw new Error("JSON not found in Python output");

            const output = JSON.parse(match[1]);
            logger.info('Topic modeling complete');
            return res.status(200).json({
                message: 'Topic modeling complete',
                output: output,
            });
        } catch (parseError) {
            logger.error('Failed to parse Python output (topic modeling)', { stdout });
            return res.status(500).json({
                error: 'Invalid JSON output from Python script',
                raw: stdout,
            });
        }
    });
};

module.exports.getDefaultDatasets = (req, res) => {
    const datasetsDir = path.join(__dirname, '..', 'datasets');

    fs.readdir(datasetsDir, (err, files) => {
        if (err) {
            logger.error('Failed to read datasets directory', { error: err.message });
            return res.status(500).json({ error: 'Failed to read datasets directory' });
        }

        const csvFiles = files.filter(file => file.endsWith('.csv'));
        if (!csvFiles.length) {
            logger.warn('No CSV datasets found');
            return res.status(404).json({ error: 'No CSV datasets found.' });
        }

        logger.info(`Found ${csvFiles.length} default datasets`);
        return res.status(200).json({ datasets: csvFiles });
    });
};

module.exports.runTopicModelingDefault = (req, res) => {
    const { datasetName, numTopics = 5 } = req.body;

    if (!datasetName) {
        logger.warn('No dataset name provided for default topic modeling');
        return res.status(400).json({ error: 'Dataset name is required' });
    }

    const datasetPath = path.join(__dirname, '..', 'datasets', datasetName);

    if (!fs.existsSync(datasetPath)) {
        logger.warn(`Dataset not found: ${datasetName}`);
        return res.status(404).json({ error: 'Dataset not found' });
    }

    const pythonScript = path.join(__dirname, '..', 'python_scripts', 'topic_modeling.py');

    logger.info(`Running topic modeling on default dataset: ${datasetName}`);

    exec(`"${PYTHON_CMD}" "${pythonScript}" "${datasetPath}" "${numTopics}"`, (error, stdout, stderr) => {
        logger.error('[SERVER] STDERR:', stderr);
        if (error) logger.error('[SERVER] ERROR:', error.message);

        if (error) {
            return res.status(500).json({
                error: 'Python script execution failed',
                detail: stderr || error.message,
            });
        }

        if (!stdout || stdout.trim() === '') {
            logger.error('Python script returned empty output (default topic modeling)');
            return res.status(500).json({
                error: 'Python script returned empty output',
            });
        }

        try {
            const jsonRegex = /({[\s\S]*})/;
            const match = stdout.match(jsonRegex);
            if (!match) throw new Error("JSON not found in Python output");

            const output = JSON.parse(match[1]);
            logger.info('Default topic modeling complete');
            return res.status(200).json({
                message: 'Topic modeling complete',
                output,
            });
        } catch (parseError) {
            logger.error('Failed to parse Python output (default topic modeling)', { stdout });
            return res.status(500).json({
                error: 'Invalid JSON output from Python script',
                raw: stdout,
            });
        }
    });
};
