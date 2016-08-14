'use strict';

const _ = require('lodash');
const proxyquire = require('proxyquire');
const q = require('q');
const fs = require('q-io/fs');
const optipng = require('optipng-bin');

const RunnerFactory = require('../lib/runner');
const AllSuitesRunner = require('../lib/runner/all-suites-runner');
const mkDummyCollection = require('./utils').mkDummyCollection;

describe('App', () => {
    const sandbox = sinon.sandbox.create();

    let suiteCollection;
    let Gemini;
    let App;
    let app;

    let execFile;
    let compareSize;

    const stubFs_ = () => {
        sandbox.stub(fs, 'exists').returns(q(false));
        sandbox.stub(fs, 'removeTree').returns(q());
        sandbox.stub(fs, 'makeDirectory').returns(q());
        sandbox.stub(fs, 'makeTree').returns(q());
        sandbox.stub(fs, 'copy').returns(q());
    };

    const mkDummyTest_ = (params) => {
        return _.defaults(params || {}, {
            suite: {path: 'default_suite_path'},
            state: 'default_state',
            browserId: 'default_browser',
            referencePath: 'default_reference_path',
            currentPath: 'default_current_path'
        });
    };

    const mkCompressionRes = (params) => {
        params = _.defaults(params || {}, {
            currentPath: 'default_current_path',
            referencePath: 'default_reference_path',
            currentSize: 1000,
            referenceSize: 750
        });

        const difference = params.currentSize - params.referenceSize;
        const sizes = [params.currentSize, params.referenceSize, difference];

        return [params.currentPath, params.referencePath, 'difference'].reduce((compression, key, i) => {
            compression[key] = sizes[i];
            return compression;
        }, {});
    };

    const mkApp_ = (config) => new App(config || {});

    beforeEach(() => {
        suiteCollection = mkDummyCollection();

        Gemini = sandbox.stub();
        Gemini.prototype.browserIds = [];
        Gemini.prototype.readTests = sandbox.stub().returns(q(suiteCollection));
        Gemini.prototype.test = sandbox.stub().returns(q());

        compareSize = sandbox.stub();
        compareSize.returns(q(mkCompressionRes()));
        execFile = sandbox.stub().yields(null);

        App = proxyquire('../lib/app', {
            './find-gemini': sandbox.stub().returns(Gemini),
            'compare-size': compareSize,
            'child_process': {execFile}
        });

        app = mkApp_();
    });

    afterEach(() => sandbox.restore());

    describe('initialize', () => {
        beforeEach(() => stubFs_());

        it('should remove old fs tree for current images dir if it exists', () => {
            app.currentDir = 'current_dir';

            fs.exists.withArgs('current_dir').returns(q(true));

            return app.initialize()
                .then(() => assert.calledWith(fs.removeTree, 'current_dir'));
        });

        it('should remove old fs tree for diff images dir if it exists', () => {
            app.diffDir = 'diff_dir';

            fs.exists.withArgs('diff_dir').returns(q(true));

            return app.initialize()
                .then(() => assert.calledWith(fs.removeTree, 'diff_dir'));
        });

        it('should create new tree for current images dir', () => {
            app.currentDir = 'current_dir';

            return app.initialize()
                .then(() => assert.calledWith(fs.makeDirectory, 'current_dir'));
        });

        it('should create new tree for diff images dir', () => {
            app.currentDir = 'diff_dir';

            return app.initialize()
                .then(() => assert.calledWith(fs.makeDirectory, 'diff_dir'));
        });

        it('should read tests', () => {
            const app = mkApp_({
                testFiles: ['test_file', 'another_test_file'],
                grep: 'grep'
            });

            return app.initialize()
                .then(() => {
                    assert.calledWith(Gemini.prototype.readTests,
                        ['test_file', 'another_test_file'], 'grep');
                });
        });
    });

    describe('run', () => {
        it('should create and execute runner', () => {
            const runnerInstance = sinon.createStubInstance(AllSuitesRunner);

            sandbox.stub(RunnerFactory, 'create').returns(runnerInstance);

            app.run();

            assert.called(runnerInstance.run);
        });

        it('should pass run handler to runner which will execute gemeni', () => {
            const runnerInstance = sinon.createStubInstance(AllSuitesRunner);

            runnerInstance.run.yields();
            sandbox.stub(RunnerFactory, 'create').returns(runnerInstance);

            app.run();

            assert.called(Gemini.prototype.test);
        });
    });

    describe('addNoReferenceTest', () => {
        beforeEach(() => sandbox.stub(app, 'addFailedTest'));

        it('should add to test reference image path', () => {
            const test = {
                suite: {id: 1},
                state: {name: 'state'},
                browserId: 'browser'
            };

            sandbox.stub(app, 'getScreenshotPath').returns('some_screenshot_path');
            app.addNoReferenceTest(test);

            assert.equal(test.referencePath, 'some_screenshot_path');
        });

        it('should add test with no reference error to failed tests', () => {
            const test = {
                suite: {id: 1},
                state: {name: 'state'},
                browserId: 'browser'
            };

            sandbox.stub(app, 'getScreenshotPath');
            app.addNoReferenceTest(test);

            assert.calledWith(app.addFailedTest, test);
        });
    });

    describe('updateReferenceImage', () => {
        beforeEach(() => {
            stubFs_();
            sandbox.stub(app, 'refPathToURL');
        });

        it('should reject reference update if no failed test registered', () => {
            const test = mkDummyTest_();

            return assert.isRejected(app.updateReferenceImage(test), 'No such test failed');
        });

        it('should create directory tree for reference image before saving', () => {
            const referencePath = 'path/to/reference/image.png';
            const test = mkDummyTest_({referencePath});

            compareSize.returns(q(mkCompressionRes({referencePath})));

            app.addFailedTest(test);

            return app.updateReferenceImage(test)
                .then(() => assert.calledWith(fs.makeTree, 'path/to/reference'));
        });

        it('should be resolved with URL to updated reference', () => {
            const test = mkDummyTest_();

            app.refPathToURL.returns(q('http://dummy_ref.url'));
            app.addFailedTest(test);

            return app.updateReferenceImage(test)
                .then((result) => assert.equal(result, 'http://dummy_ref.url'));
        });
    });

    describe('compress and copy reference image', () => {
        beforeEach(() => sandbox.stub(app, 'refPathToURL'));

        it('should call execFile with optipng and pathes to ref and curr img', () => {
            const referencePath = 'path/to/reference/image.png';
            const currentPath = 'path/to/current/image.png';

            const test = mkDummyTest_({referencePath, currentPath});

            compareSize.returns(q(mkCompressionRes({referencePath, currentPath})));

            app.addFailedTest(test);

            return app.updateReferenceImage(test)
                .then(() => assert.calledWith(execFile, optipng,
                    ['-out', referencePath, currentPath]));
        });
    });

    describe('calculate compression size', () => {
        beforeEach(() => sandbox.stub(app, 'refPathToURL'));

        it('should call compareSize with ref and curr images', () => {
            const currentPath = 'path/to/current/image.png';
            const referencePath = 'path/to/reference/image.png';

            const test = mkDummyTest_({referencePath, currentPath});

            compareSize.returns(q(mkCompressionRes({referencePath, currentPath})));

            app.addFailedTest(test);

            return app.updateReferenceImage(test)
                .then(() => assert.calledWithExactly(
                    compareSize, test.referencePath, test.currentPath
                ));
        });

        it('should log size on which the ref image has been compressed (in percents)', () => {
            sandbox.spy(console, 'log');

            const currentPath = 'path/to/current/image.png';
            const referencePath = 'path/to/reference/image.png';

            const currentSize = 30000;
            const referenceSize = 15000;
            const diffInPercent = Math.round(referenceSize * 100 / currentSize);

            const test = mkDummyTest_({referencePath, currentPath});

            compareSize.returns(q(mkCompressionRes({
                referencePath, currentPath, currentSize, referenceSize
            })));

            app.addFailedTest(test);

            return app.updateReferenceImage(test)
                .then(() => assert.calledWithExactly(
                    console.log, sinon.match.string, test.referencePath, diffInPercent
                ));
        });
    });

    describe('refPathToURL', () => {
        beforeEach(() => {
            app.referenceDirs = {
                'browser_id': 'browser_reference_dir'
            };
        });

        it('should append timestamp to resulting URL', () => {
            const result = app.refPathToURL('full_path', 'browser_id');

            return assert.match(result, /\?t=\d+/);
        });
    });

    describe('currentPathToURL', () => {
        it('should append timestamp to resulting URL', () => {
            const result = app.currentPathToURL('full_path');

            return assert.match(result, /\?t=\d+/);
        });
    });
});
