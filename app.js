const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const bcrypt = require('bcryptjs');
const { exec } = require('child_process');
const fetch = require('node-fetch');
const app = express();
const port = 3001;
require('dotenv').config();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

mongoose.connect('mongodb://127.0.0.1:27017/quizDB')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Gemini API Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Correct Gemini API endpoint and model name for v1 API
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent';
const GEMINI_HEADERS = {
  'Content-Type': 'application/json'
};

// Gemini API call function
async function callGeminiAPI(prompt) {
  try {
    console.log('🔄 Calling Gemini API...');
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: GEMINI_HEADERS,
      body: JSON.stringify({
        contents: [
          { parts: [{ text: prompt }] }
        ]
      })
    });

    console.log(`📡 Gemini response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`❌ Gemini error response:`, errorText);
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`🤖 Gemini success response:`, result);

    // Extract text from Gemini response
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      return text;
    } else {
      throw new Error('No text returned from Gemini');
    }
  } catch (error) {
    console.error(`❌ Gemini API error:`, error.message);
    throw error;
  }
}

// Schemas
const resultSchema = new mongoose.Schema({
  username: String,
  email: String,
  category: String,
  score: Number,
  total: Number,
  submittedAt: { type: Date, default: Date.now },
  quizType: { type: String, enum: ['standard', 'ai-powered'], default: 'standard' },
  aiGenerated: { type: Boolean, default: false },
  generationSource: { type: String, enum: ['COHERE_API', 'PYTHON_COHERE', 'INTELLIGENT_FALLBACK', 'MANUAL'], default: 'MANUAL' },
  questionIds: [String] // Array of question IDs used in the quiz
});

const userSchema = new mongoose.Schema({
  username: String,
  email: String,
  password: String,

  // Engagement fields: daily streaks and coins
  engagement: {
    streak: {
      current: { type: Number, default: 0 },
      longest: { type: Number, default: 0 },
      lastActiveDate: { type: Date, default: null }
    },
    coins: {
      balance: { type: Number, default: 0 },
      lifetimeEarned: { type: Number, default: 0 },
      lifetimeSpent: { type: Number, default: 0 },
      history: [{
        action: { type: String, required: true },
        amount: { type: Number, required: true }, // positive for earn, negative for spend
        createdAt: { type: Date, default: Date.now },
        meta: mongoose.Schema.Types.Mixed
      }]
    }
  }
});

// Enhanced User Performance Schema
const UserPerformanceSchema = new mongoose.Schema({
  email: { type: String, required: true },
  category: { type: String, required: true },
  overallLevel: { type: String, enum: ['beginner', 'intermediate', 'advanced', 'expert'], default: 'beginner' },
  skillMetrics: {
    accuracy: { type: Number, default: 0 },
    speed: { type: Number, default: 0 },
    consistency: { type: Number, default: 0 },
    improvement: { type: Number, default: 0 },
    conceptualUnderstanding: { type: Number, default: 0 }
  },
  detailedProfile: {
    learningStyle: { type: String, enum: ['visual', 'practical', 'theoretical'], default: 'practical' },
    preferredDifficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    attentionSpan: { type: Number, default: 60 },
    commonMistakes: [String],
    masteredConcepts: [String]
  },
  weakAreas: [String],
  strongAreas: [String],
  questionHistory: [{
    questionId: String,
    topic: String,
    difficulty: String,
    wasCorrect: Boolean,
    timeSpent: Number,
    attempts: Number,
    generatedAt: Date
  }],
  lastAssessment: { type: Date, default: Date.now },
  quizzesTaken: { type: Number, default: 0 },
  totalQuestions: { type: Number, default: 0 },
  correctAnswers: { type: Number, default: 0 }
});

// Generated Questions Schema
const GeneratedQuestionSchema = new mongoose.Schema({
  category: { type: String, required: true },
  question: { type: String, required: true },
  options: [String],
  correctAnswer: { type: String, required: true },
  difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced', 'expert'], default: 'beginner' },
  topic: String,
  explanation: String,
  hasBeenUsed: { type: Boolean, default: false },
  userResponse: {
    wasCorrect: Boolean,
    timeSpent: Number,
    submittedAt: Date
  },
  generatedFor: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const Result = mongoose.model('Result', resultSchema);
const User = mongoose.model('User', userSchema);
const UserPerformance = mongoose.model('UserPerformance', UserPerformanceSchema);
const GeneratedQuestion = mongoose.model('GeneratedQuestion', GeneratedQuestionSchema);

// AI Question Generator Class
class AIQuestionGenerator {
  static async generateUniqueQuestions(userEmail, category, userPerformance, count = 10) {
    try {
      console.log(`Generating AI questions for ${userEmail} in ${category}`);

      // Get user's question history to avoid repetition
      const previousQuestions = await GeneratedQuestion.find({
        generatedFor: userEmail,
        category,
        hasBeenUsed: true
      }).select('question topic').limit(20);

      // Create user profile
      const userProfile = this.createUserProfile(userPerformance, previousQuestions);

      // Generate Gemini prompt
      const aiPrompt = this.createPersonalizedPrompt(category, userProfile, count);

      console.log('Calling Gemini API...');
      const geminiResponse = await callGeminiAPI(aiPrompt);

      // Parse Gemini response
      let questions;
      try {
        const responseText = geminiResponse.trim();
        // Remove markdown formatting if present
        const jsonText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        questions = JSON.parse(jsonText);
      } catch (parseError) {
        console.error('Error parsing Gemini response:', parseError);
        throw new Error('Invalid Gemini response format');
      }

      // Validate questions array
      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('No valid questions returned from Gemini');
      }

      // Save generated questions to database
      const savedQuestions = await Promise.all(
        questions.map(async (q) => {
          const generatedQuestion = new GeneratedQuestion({
            generatedFor: userEmail,
            category,
            question: q.question,
            options: q.options,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation || 'Gemini-generated explanation',
            difficulty: q.difficulty || userPerformance.overallLevel,
            topic: q.topic || category,
            aiPrompt: aiPrompt.substring(0, 500)
          });
          return await generatedQuestion.save();
        })
      );

      console.log(`Successfully generated ${savedQuestions.length} Gemini questions`);
      return savedQuestions;

    } catch (error) {
      console.error('Error generating Gemini AI questions:', error);
      // Fallback to pre-generated questions
      return await this.generateFallbackQuestions(userEmail, category, userPerformance, count);
    }
  }

  static createUserProfile(userPerformance, previousQuestions) {
    return {
      level: userPerformance.overallLevel,
      accuracy: userPerformance.skillMetrics.accuracy,
      weakAreas: userPerformance.weakAreas,
      strongAreas: userPerformance.strongAreas,
      learningStyle: userPerformance.detailedProfile.learningStyle,
      commonMistakes: userPerformance.detailedProfile.commonMistakes,
      masteredConcepts: userPerformance.detailedProfile.masteredConcepts,
      questionHistory: previousQuestions.map(q => q.question.substring(0, 50)),
      quizzesTaken: userPerformance.quizzesTaken,
      averageSpeed: userPerformance.skillMetrics.speed,
      consistency: userPerformance.skillMetrics.consistency
    };
  }

  static createPersonalizedPrompt(category, userProfile, count) {
    let prompt = `Generate ${count} unique ${category} quiz questions for a user with this profile:

Level: ${userProfile.level}
Accuracy: ${(userProfile.accuracy * 100).toFixed(1)}%
Quizzes Taken: ${userProfile.quizzesTaken}
Learning Style: ${userProfile.learningStyle}

Weak Areas: ${userProfile.weakAreas.length > 0 ? userProfile.weakAreas.join(', ') : 'None'}
Strong Areas: ${userProfile.strongAreas.length > 0 ? userProfile.strongAreas.join(', ') : 'None'}

AVOID these previous questions: ${userProfile.questionHistory.join(' | ')}

Requirements:
1. Create completely unique questions not similar to previous ones
2. Focus 60% on weak areas if any exist
3. Match ${userProfile.learningStyle} learning style
4. Use ${userProfile.level} difficulty level
5. Include practical examples

Respond with valid JSON array only:
[
  {
    "question": "Question text here",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": "Option A",
    "difficulty": "${userProfile.level}",
    "topic": "Specific topic",
    "explanation": "Why this answer is correct"
  }
]`;

    return prompt;
  }

  static async generateFallbackQuestions(userEmail, category, userPerformance, count) {
    console.log('Using fallback questions');
    
    const questionPools = {
      'HTML': {
        'beginner': [
          {
            question: "What does HTML stand for?",
            options: ["Hyper Text Markup Language", "High Tech Modern Language", "Home Tool Markup Language", "Hyperlink Text Markup Language"],
            correctAnswer: "Hyper Text Markup Language",
            topic: "HTML Basics",
            explanation: "HTML stands for Hyper Text Markup Language, the standard markup language for web pages."
          },
          {
            question: "Which HTML element is used for the largest heading?",
            options: ["<h6>", "<h1>", "<heading>", "<header>"],
            correctAnswer: "<h1>",
            topic: "HTML Elements",
            explanation: "<h1> represents the largest heading in HTML."
          },
          {
            question: "What is the correct HTML element for inserting a line break?",
            options: ["<break>", "<lb>", "<br>", "<newline>"],
            correctAnswer: "<br>",
            topic: "HTML Elements",
            explanation: "The <br> element creates a line break in HTML."
          },
          {
            question: "Which attribute specifies a unique identifier for an HTML element?",
            options: ["class", "name", "id", "key"],
            correctAnswer: "id",
            topic: "HTML Attributes",
            explanation: "The 'id' attribute provides a unique identifier for HTML elements."
          },
          {
            question: "How do you create a hyperlink in HTML?",
            options: ["<link>", "<a>", "<href>", "<url>"],
            correctAnswer: "<a>",
            topic: "HTML Links",
            explanation: "The <a> element with href attribute creates hyperlinks."
          }
        ],
        'intermediate': [
          {
            question: "Which attribute is used to merge table cells horizontally?",
            options: ["rowspan", "colspan", "cellspan", "merge"],
            correctAnswer: "colspan",
            topic: "HTML Tables",
            explanation: "colspan specifies how many columns a cell should span."
          },
          {
            question: "What is the purpose of the <meta> tag?",
            options: ["Create links", "Add metadata", "Define sections", "Style elements"],
            correctAnswer: "Add metadata",
            topic: "HTML Document Structure",
            explanation: "<meta> tags provide metadata about the HTML document."
          },
          {
            question: "Which HTML5 input type is used for email addresses?",
            options: ["text", "email", "mail", "address"],
            correctAnswer: "email",
            topic: "HTML Forms",
            explanation: "The email input type validates email address format."
          },
          {
            question: "What does the 'required' attribute do in forms?",
            options: ["Makes field optional", "Makes field mandatory", "Validates input", "Styles the field"],
            correctAnswer: "Makes field mandatory",
            topic: "HTML Forms",
            explanation: "The required attribute makes form fields mandatory to fill."
          },
          {
            question: "Which HTML5 element represents a sidebar?",
            options: ["<sidebar>", "<aside>", "<nav>", "<section>"],
            correctAnswer: "<aside>",
            topic: "HTML5 Semantic Elements",
            explanation: "<aside> represents content tangentially related to main content."
          }
        ],
        'advanced': [
          {
            question: "Which HTML5 API allows offline web application functionality?",
            options: ["Service Worker", "Local Storage", "Session Storage", "Web SQL"],
            correctAnswer: "Service Worker",
            topic: "HTML5 APIs",
            explanation: "Service Workers enable offline functionality by intercepting network requests."
          },
          {
            question: "What is the difference between <section> and <article>?",
            options: ["No difference", "<section> is standalone", "<article> is standalone", "Both deprecated"],
            correctAnswer: "<article> is standalone",
            topic: "HTML5 Semantic Elements",
            explanation: "<article> is for standalone content, <section> for thematic grouping."
          },
          {
            question: "Which attribute makes an HTML element editable?",
            options: ["editable", "contenteditable", "edit", "input"],
            correctAnswer: "contenteditable",
            topic: "HTML Attributes",
            explanation: "contenteditable attribute makes elements editable by users."
          },
          {
            question: "What is the purpose of the <picture> element?",
            options: ["Display images", "Responsive images", "Image gallery", "Image editing"],
            correctAnswer: "Responsive images",
            topic: "HTML5 Elements",
            explanation: "<picture> provides responsive image solutions with multiple sources."
          },
          {
            question: "Which HTML5 attribute specifies the character encoding?",
            options: ["encoding", "charset", "char-set", "character"],
            correctAnswer: "charset",
            topic: "HTML Document Structure",
            explanation: "The charset attribute in <meta> specifies character encoding."
          }
        ]
      },
      'CSS': {
        'beginner': [
          {
            question: "What does CSS stand for?",
            options: ["Cascading Style Sheets", "Computer Style Sheets", "Creative Style Sheets", "Colorful Style Sheets"],
            correctAnswer: "Cascading Style Sheets",
            topic: "CSS Basics",
            explanation: "CSS stands for Cascading Style Sheets, used for styling web pages."
          },
          {
            question: "Which CSS property is used to change the text color?",
            options: ["color", "text-color", "font-color", "text-style"],
            correctAnswer: "color",
            topic: "CSS Properties",
            explanation: "The 'color' property is used to set the color of text."
          },
          {
            question: "How do you add CSS to an HTML document?",
            options: ["<style>", "<css>", "<script>", "<link>"],
            correctAnswer: "<style>",
            topic: "CSS Basics",
            explanation: "CSS can be added using <style> tags or <link> tags for external stylesheets."
          },
          {
            question: "Which CSS property controls the spacing between elements?",
            options: ["margin", "padding", "spacing", "gap"],
            correctAnswer: "margin",
            topic: "CSS Layout",
            explanation: "The 'margin' property controls the space outside an element's border."
          },
          {
            question: "What is the correct CSS syntax?",
            options: ["selector {property: value;}", "{selector: property: value;}", "selector = property: value", "selector (property: value)"],
            correctAnswer: "selector {property: value;}",
            topic: "CSS Basics",
            explanation: "CSS syntax consists of a selector followed by declarations in curly braces."
          }
        ],
        'intermediate': [
          {
            question: "Which CSS display value removes an element from the document flow?",
            options: ["none", "hidden", "invisible", "remove"],
            correctAnswer: "none",
            topic: "CSS Layout",
            explanation: "display: none completely removes the element from the document flow."
          },
          {
            question: "What is the difference between margin and padding?",
            options: ["No difference", "Margin is inside, padding is outside", "Padding is inside, margin is outside", "Margin is for text, padding for elements"],
            correctAnswer: "Padding is inside, margin is outside",
            topic: "CSS Layout",
            explanation: "Padding is the space inside an element's border, margin is the space outside."
          },
          {
            question: "Which CSS property is used to create CSS Grid layouts?",
            options: ["display: grid", "layout: grid", "grid: true", "position: grid"],
            correctAnswer: "display: grid",
            topic: "CSS Layout",
            explanation: "display: grid creates a CSS Grid container for advanced layouts."
          }
        ],
        'advanced': [
          {
            question: "Which CSS property is used to create CSS Grid layouts?",
            options: ["display: grid", "grid-template-areas", "grid-template-columns", "grid-area"],
            correctAnswer: "display: grid",
            topic: "CSS Grid",
            explanation: "display: grid enables CSS Grid layout on the container."
          },
          {
            question: "What is the purpose of the grid-template-areas property?",
            options: ["Define grid layout", "Set item positions", "Create named grid areas", "All of the above"],
            correctAnswer: "All of the above",
            topic: "CSS Grid",
            explanation: "grid-template-areas defines the grid structure and item placement."
          },
          {
            question: "How do you specify a fallback value for a CSS variable?",
            options: ["var(--my-variable, fallbackValue)", "fallback(var(--my-variable))", "default(var(--my-variable), fallbackValue)", "var(--my-variable) ? fallbackValue"],
            correctAnswer: "var(--my-variable, fallbackValue)",
            topic: "CSS Variables",
            explanation: "The var() function can take a fallback value if the variable is not defined."
          }
        ]
      },
      'JavaScript': {
        'beginner': [
          {
            question: "What does JavaScript primarily add to web pages?",
            options: ["Styling", "Interactivity", "Structure", "Database connectivity"],
            correctAnswer: "Interactivity",
            topic: "JavaScript Basics",
            explanation: "JavaScript adds interactivity and dynamic behavior to web pages."
          },
          {
            question: "Which keyword is used to declare a variable in modern JavaScript?",
            options: ["var", "let", "const", "Both let and const"],
            correctAnswer: "Both let and const",
            topic: "JavaScript Basics",
            explanation: "Modern JavaScript uses 'let' for mutable variables and 'const' for constants."
          },
          {
            question: "What is the correct way to write a JavaScript array?",
            options: ["var colors = 'red', 'green', 'blue'", "var colors = (1:'red', 2:'green', 3:'blue')", "var colors = ['red', 'green', 'blue']", "var colors = 1 = ('red'), 2 = ('green'), 3 = ('blue')"],
            correctAnswer: "var colors = ['red', 'green', 'blue']",
            topic: "JavaScript Basics",
            explanation: "JavaScript arrays are written with square brackets and comma-separated values."
          },
          {
            question: "How do you write 'Hello World' in an alert box?",
            options: ["alertBox('Hello World');", "msg('Hello World');", "alert('Hello World');", "msgBox('Hello World');"],
            correctAnswer: "alert('Hello World');",
            topic: "JavaScript Basics",
            explanation: "The alert() function displays a dialog box with a message."
          },
          {
            question: "Which operator is used to assign a value to a variable?",
            options: ["*", "=", "x", "-"],
            correctAnswer: "=",
            topic: "JavaScript Basics",
            explanation: "The assignment operator (=) is used to assign values to variables."
          }
        ],
        'intermediate': [
          {
            question: "What is the difference between '==' and '===' in JavaScript?",
            options: ["No difference", "'==' checks value, '===' checks value and type", "'===' checks value, '==' checks value and type", "Both are deprecated"],
            correctAnswer: "'==' checks value, '===' checks value and type",
            topic: "JavaScript Operators",
            explanation: "'==' performs type coercion, while '===' checks both value and type without conversion."
          },
          {
            question: "What does the 'this' keyword refer to in JavaScript?",
            options: ["The current function", "The current object", "The global object", "It depends on the context"],
            correctAnswer: "It depends on the context",
            topic: "JavaScript Context",
            explanation: "The 'this' keyword refers to different objects depending on how it's used."
          }
        ],
        'advanced': [
          {
            question: "What is the purpose of async/await in JavaScript?",
            options: ["To handle synchronous operations", "To handle asynchronous operations more easily", "To create classes", "To declare variables"],
            correctAnswer: "To handle asynchronous operations more easily",
            topic: "Async/Await",
            explanation: "Async/await provides a cleaner way to handle asynchronous operations than callbacks or promises alone."
          }
        ]
      }
    };

    const levelQuestions = questionPools[category]?.[userPerformance.overallLevel] || questionPools[category]?.['beginner'] || [];
    
    // Select questions avoiding repetition
    const usedQuestions = await GeneratedQuestion.find({ 
      generatedFor: userEmail, 
      category,
      hasBeenUsed: true 
    }).select('question');
    
    const usedTexts = usedQuestions.map(q => q.question);
    const availableQuestions = levelQuestions.filter(q => 
      !usedTexts.some(used => used.includes(q.question.substring(0, 30)))
    );

    // If no unused questions, reset and use any questions
    const questionsToUse = availableQuestions.length >= count ? availableQuestions : levelQuestions;
    const selectedQuestions = questionsToUse.slice(0, count);

    // Save as generated questions
    const savedQuestions = await Promise.all(
      selectedQuestions.map(async (q) => {
        const generatedQuestion = new GeneratedQuestion({
          generatedFor: userEmail,
          category,
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
          difficulty: userPerformance.overallLevel,
          topic: q.topic,
          aiPrompt: "Fallback question selection"
        });
        return await generatedQuestion.save();
      })
    );

    return savedQuestions;
  }
}

// Helper Functions


async function calculateUniquenessScore(userEmail, category) {
  const totalQuestions = await GeneratedQuestion.countDocuments({ generatedFor: userEmail, category });
  const uniqueTopics = await GeneratedQuestion.distinct('topic', { generatedFor: userEmail, category });
  
  return Math.min(100, (uniqueTopics.length * 10) + (totalQuestions * 2));
}

async function updateAdvancedUserPerformance(email, category, answers, timeSpent) {
  let userPerformance = await UserPerformance.findOne({ email, category });
  
  if (!userPerformance) return;
  // Analyze performance
  const incorrectAnswers = answers.filter(a => !a.isCorrect);
  const commonMistakes = incorrectAnswers.map(a => a.topic);
  
  const topicPerformance = {};
  answers.forEach(answer => {
    if (!topicPerformance[answer.topic]) {
      topicPerformance[answer.topic] = { correct: 0, total: 0 };
    }
    topicPerformance[answer.topic].total++;
    if (answer.isCorrect) topicPerformance[answer.topic].correct++;
  });

  const weakAreas = [];
  const strongAreas = [];
  
  Object.entries(topicPerformance).forEach(([topic, perf]) => {
    const accuracy = perf.correct / perf.total;
    if (accuracy < 0.6) weakAreas.push(topic);
    else if (accuracy >= 0.8) strongAreas.push(topic);
  });

  // Update performance metrics
  userPerformance.quizzesTaken += 1;
  userPerformance.totalQuestions += answers.length;
  userPerformance.correctAnswers += answers.filter(a => a.isCorrect).length;
  userPerformance.weakAreas = [...new Set([...userPerformance.weakAreas, ...weakAreas])];
  userPerformance.strongAreas = [...new Set([...userPerformance.strongAreas, ...strongAreas])];
  userPerformance.detailedProfile.commonMistakes = [...new Set([...userPerformance.detailedProfile.commonMistakes, ...commonMistakes])];
  
  // Update question history
  answers.forEach(answer => {
    userPerformance.questionHistory.push({
      questionId: answer.questionId,
      topic: answer.topic,
      difficulty: userPerformance.overallLevel,
      wasCorrect: answer.isCorrect,
      timeSpent: answer.timeSpent || 0,
      attempts: 1,
      generatedAt: new Date()
    });
  });

  // Keep only last 50 questions
  if (userPerformance.questionHistory.length > 50) {
    userPerformance.questionHistory = userPerformance.questionHistory.slice(-50);
  }

  userPerformance.lastAssessment = new Date();
  await userPerformance.save();
}

// Add missing function - was being called but not defined
async function updateUserLevelAssessment(email, category, userPerformance) {
  try {
    const accuracy = userPerformance.correctAnswers / userPerformance.totalQuestions;
    
    let newLevel = 'beginner';
    if (accuracy >= 0.8 && userPerformance.quizzesTaken >= 3) {
      newLevel = 'advanced';
    } else if (accuracy >= 0.6 && userPerformance.quizzesTaken >= 2) {
      newLevel = 'intermediate';
    }
    
    userPerformance.overallLevel = newLevel;
    await userPerformance.save();
    
    console.log(`Updated user level to: ${newLevel} (accuracy: ${(accuracy * 100).toFixed(1)}%)`);
  } catch (error) {
    console.error('Error updating user level:', error);
  }
}

// Add missing function that was being called
async function generateSingleAdaptiveQuestion(email, category, adaptedProfile, questionNumber, previousAnswers) {
  console.log('🔄 Calling generateSingleAdaptiveQuestionFast...');
  return await generateSingleAdaptiveQuestionFast(email, category, adaptedProfile, questionNumber, previousAnswers);
}

// Add the missing generateIntelligentFallbackQuestion function and related helpers
function generateAIInspiredQuestionFast(aiResponse, adaptedProfile, questionNumber) {
  const topic = adaptedProfile.focusArea || 'HTML Basics';
  const level = adaptedProfile.currentLevel || 'beginner';
  
  // Extract any useful keywords from AI
  const keywords = extractHTMLKeywords(aiResponse);
  console.log('🔍 AI keywords:', keywords);
  
  // Smart question selection based on AI keywords and user profile
  const questionTemplates = getTopicQuestions(topic, level);
  const selectedTemplate = questionTemplates[questionNumber % questionTemplates.length];
  
  return {
    question: selectedTemplate.question,
    options: selectedTemplate.options,
    correctAnswer: selectedTemplate.correctAnswer,
    topic: topic,
    explanation: selectedTemplate.explanation
  };
}

// Intelligent fallback with fast generation
async function generateIntelligentFallbackQuestion(email, category, adaptedProfile, questionNumber) {
  console.log(`🚀 FAST intelligent fallback generation for ${category}...`);
  
  const topic = adaptedProfile.focusArea || getCategoryDefaults(category).defaultTopic;
  const level = adaptedProfile.currentLevel || 'beginner';
  
  // Get appropriate questions for topic and level - ENSURE CATEGORY SPECIFIC
  const questionPool = getTopicQuestions(topic, level, category);
  
  // Smart selection based on user history
  const userHistory = await GeneratedQuestion.find({
    generatedFor: email,
    category,
    hasBeenUsed: true
  }).select('question').limit(10);
  
  const usedQuestions = userHistory.map(q => q.question.substring(0, 30));
  
  // Find unused question
  let selectedQuestion = null;
  for (const q of questionPool) {
    const isUsed = usedQuestions.some(used => q.question.includes(used) || used.includes(q.question.substring(0, 30)));
    if (!isUsed) {
      selectedQuestion = q;
      break;
    }
  }
  
  // If all used, pick random
  if (!selectedQuestion) {
    selectedQuestion = questionPool[Math.floor(Math.random() * questionPool.length)];
  }
  
  // Save to database
  const generatedQuestion = new GeneratedQuestion({
    category,
    question: selectedQuestion.question,
    options: selectedQuestion.options,
    correctAnswer: selectedQuestion.correctAnswer,
    difficulty: level,
    topic: topic,
    explanation: selectedQuestion.explanation,
    generatedFor: email,
    createdAt: new Date()
  });

  const saved = await generatedQuestion.save();
  
  return {
    id: saved._id,
    question: selectedQuestion.question,
    options: selectedQuestion.options,
    correctAnswer: selectedQuestion.correctAnswer,
    difficulty: level,
    topic: topic,
    explanation: selectedQuestion.explanation,
    generatedBy: 'INTELLIGENT_FALLBACK',
    _aiMetadata: {
      model: 'Intelligent-System',
      generationTime: 50,
      source: 'INTELLIGENT_FALLBACK'
    }
  };
}

// Enhanced getTopicQuestions function with category filtering
function getTopicQuestions(topic, level, category) {
  const questionDB = {
    'JavaScript Basics': {
      'beginner': [
        {
          question: "What does JavaScript primarily add to web pages?",
          options: ["Styling", "Interactivity", "Structure", "Database connectivity"],
          correctAnswer: "Interactivity",
          topic: "JavaScript Basics",
          explanation: "JavaScript adds interactivity and dynamic behavior to web pages."
        },
        {
          question: "Which keyword is used to declare a variable in modern JavaScript?",
          options: ["var", "let", "const", "Both let and const"],
          correctAnswer: "Both let and const",
          topic: "JavaScript Basics",
          explanation: "Modern JavaScript uses 'let' for mutable variables and 'const' for constants."
        },
        {
          question: "What is the correct way to write a JavaScript array?",
          options: ["var colors = 'red', 'green', 'blue'", "var colors = (1:'red', 2:'green', 3:'blue')", "var colors = ['red', 'green', 'blue']", "var colors = 1 = ('red'), 2 = ('green'), 3 = ('blue')"],
          correctAnswer: "var colors = ['red', 'green', 'blue']",
          topic: "JavaScript Basics",
          explanation: "JavaScript arrays are written with square brackets and comma-separated values."
        },
        {
          question: "How do you write 'Hello World' in an alert box?",
          options: ["alertBox('Hello World');", "msg('Hello World');", "alert('Hello World');", "msgBox('Hello World');"],
          correctAnswer: "alert('Hello World');",
          topic: "JavaScript Basics",
          explanation: "The alert() function displays a dialog box with a message."
        },
        {
          question: "Which operator is used to assign a value to a variable?",
          options: ["*", "=", "x", "-"],
          correctAnswer: "=",
          topic: "JavaScript Basics",
          explanation: "The assignment operator (=) is used to assign values to variables."
        }
      ],
      'intermediate': [
        {
          question: "What is the difference between '==' and '===' in JavaScript?",
          options: ["No difference", "'==' checks value, '===' checks value and type", "'===' checks value, '==' checks value and type", "Both are deprecated"],
          correctAnswer: "'==' checks value, '===' checks value and type",
          topic: "JavaScript Operators",
          explanation: "'==' performs type coercion, while '===' checks both value and type without conversion."
        },
        {
          question: "What does the 'this' keyword refer to in JavaScript?",
          options: ["The current function", "The current object", "The global object", "It depends on the context"],
          correctAnswer: "It depends on the context",
          topic: "JavaScript Context",
          explanation: "The 'this' keyword refers to different objects depending on how it's used."
        }
      ],
      'advanced': [
        {
          question: "What is the purpose of async/await in JavaScript?",
          options: ["To handle synchronous operations", "To handle asynchronous operations more easily", "To create classes", "To declare variables"],
          correctAnswer: "To handle asynchronous operations more easily",
          topic: "Async/Await",
          explanation: "Async/await provides a cleaner way to handle asynchronous operations than callbacks or promises alone."
        }
      ]
    },
    'Functions': {
      'beginner': [
        {
          question: "How do you call a function named 'myFunction'?",
          options: ["call myFunction()", "myFunction()", "call function myFunction", "Call.myFunction()"],
          correctAnswer: "myFunction()",
          topic: "Functions",
          explanation: "Functions are called by writing the function name followed by parentheses."
        },
        {
          question: "What is the correct syntax to create a function in JavaScript?",
          options: ["function = myFunction() {}", "function myFunction() {}", "create myFunction() {}", "def myFunction() {}"],
          correctAnswer: "function myFunction() {}",
          topic: "Functions",
          explanation: "Functions in JavaScript are declared using the 'function' keyword followed by the function name and parentheses."
        }
      ]
    },
    'Variables': {
      'beginner': [
        {
          question: "Which of these is a valid variable name in JavaScript?",
          options: ["2name", "first-name", "firstName", "first name"],
          correctAnswer: "firstName",
          topic: "Variables",
          explanation: "Variable names in JavaScript can contain letters, numbers, underscores, and dollar signs, but cannot start with a number or contain spaces or hyphens."
        }
      ]
    },
    'ES6+ Features': {
      'intermediate': [
        {
          question: "What is the purpose of the spread operator (...) in JavaScript?",
          options: ["To create comments", "To expand iterables into individual elements", "To create variables", "To end statements"],
          correctAnswer: "To expand iterables into individual elements",
          topic: "ES6+ Features",
          explanation: "The spread operator allows an iterable to be expanded into individual elements."
        }
      ]
    },
    'DOM Manipulation': {
      'intermediate': [
        {
          question: "Which method is used to select an element by its ID?",
          options: ["document.querySelector()", "document.getElementById()", "document.getElement()", "document.selectById()"],
          correctAnswer: "document.getElementById()",
          topic: "DOM Manipulation",
          explanation: "document.getElementById() is the specific method to select an element by its ID attribute."
        }
      ]
    },
    'Event Handling': {
      'intermediate': [
        {
          question: "What is event delegation in JavaScript?",
          options: ["Passing events between functions", "Handling events on parent elements for child elements", "Creating custom events", "Removing event listeners"],
          correctAnswer: "Handling events on parent elements for child elements",
          topic: "Event Handling",
          explanation: "Event delegation uses event bubbling to handle events on child elements through their parent."
        }
      ]
    },
    'Async/Await': {
      'advanced': [
        {
          question: "What is a Promise in JavaScript?",
          options: ["A guarantee that code will work", "An object representing eventual completion of an async operation", "A function parameter", "A loop construct"],
          correctAnswer: "An object representing eventual completion of an async operation",
          topic: "Promises",
          explanation: "A Promise is an object representing the eventual completion or failure of an asynchronous operation."
        }
      ]
    },
    // Add HTML topics
    'HTML Basics': {
      'beginner': [
        {
          question: "What does HTML stand for?",
          options: ["Hyper Text Markup Language", "High Tech Modern Language", "Home Tool Markup Language", "Hyperlink Text Markup Language"],
          correctAnswer: "Hyper Text Markup Language",
          topic: "HTML Basics",
          explanation: "HTML stands for Hyper Text Markup Language, the standard markup language for web pages."
        },
        {
          question: "Which HTML element is used for the largest heading?",
          options: ["<h6>", "<h1>", "<heading>", "<header>"],
          correctAnswer: "<h1>",
          topic: "HTML Elements",
          explanation: "<h1> represents the largest heading in HTML."
        },
        {
          question: "What is the correct HTML element for inserting a line break?",
          options: ["<break>", "<lb>", "<br>", "<newline>"],
          correctAnswer: "<br>",
          topic: "HTML Elements",
          explanation: "The <br> element creates a line break in HTML."
        },
        {
          question: "Which attribute specifies a unique identifier for an HTML element?",
          options: ["class", "name", "id", "key"],
          correctAnswer: "id",
          topic: "HTML Attributes",
          explanation: "The 'id' attribute provides a unique identifier for HTML elements."
        },
        {
          question: "How do you create a hyperlink in HTML?",
          options: ["<link>", "<a>", "<href>", "<url>"],
          correctAnswer: "<a>",
          topic: "HTML Links",
          explanation: "The <a> element with href attribute creates hyperlinks."
        }
      ],
      'intermediate': [
        {
          question: "Which attribute is used to merge table cells horizontally?",
          options: ["rowspan", "colspan", "cellspan", "merge"],
          correctAnswer: "colspan",
          topic: "HTML Tables",
          explanation: "colspan specifies how many columns a cell should span."
        },
        {
          question: "What is the purpose of the <meta> tag?",
          options: ["Create links", "Add metadata", "Define sections", "Style elements"],
          correctAnswer: "Add metadata",
          topic: "HTML Document Structure",
          explanation: "<meta> tags provide metadata about the HTML document."
        },
        {
          question: "Which HTML5 input type is used for email addresses?",
          options: ["text", "email", "mail", "address"],
          correctAnswer: "email",
          topic: "HTML Forms",
          explanation: "The email input type validates email address format."
        },
        {
          question: "What does the 'required' attribute do in forms?",
          options: ["Makes field optional", "Makes field mandatory", "Validates input", "Styles the field"],
          correctAnswer: "Makes field mandatory",
          topic: "HTML Forms",
          explanation: "The required attribute makes form fields mandatory to fill."
        },
        {
          question: "Which HTML5 element represents a sidebar?",
          options: ["<sidebar>", "<aside>", "<nav>", "<section>"],
          correctAnswer: "<aside>",
          topic: "HTML5 Semantic Elements",
          explanation: "<aside> represents content tangentially related to main content."
        }
      ],
      'advanced': [
        {
          question: "Which HTML5 API allows offline web application functionality?",
          options: ["Service Worker", "Local Storage", "Session Storage", "Web SQL"],
          correctAnswer: "Service Worker",
          topic: "HTML5 APIs",
          explanation: "Service Workers enable offline functionality by intercepting network requests."
        },
        {
          question: "What is the difference between <section> and <article>?",
          options: ["No difference", "<section> is standalone", "<article> is standalone", "Both deprecated"],
          correctAnswer: "<article> is standalone",
          topic: "HTML5 Semantic Elements",
          explanation: "<article> is for standalone content, <section> for thematic grouping."
        },
        {
          question: "Which attribute makes an HTML element editable?",
          options: ["editable", "contenteditable", "edit", "input"],
          correctAnswer: "contenteditable",
          topic: "HTML Attributes",
          explanation: "contenteditable attribute makes elements editable by users."
        },
        {
          question: "What is the purpose of the <picture> element?",
          options: ["Display images", "Responsive images", "Image gallery", "Image editing"],
          correctAnswer: "Responsive images",
          topic: "HTML5 Elements",
          explanation: "<picture> provides responsive image solutions with multiple sources."
        },
        {
          question: "Which HTML5 attribute specifies the character encoding?",
          options: ["encoding", "charset", "char-set", "character"],
          correctAnswer: "charset",
          topic: "HTML Document Structure",
          explanation: "The charset attribute in <meta> specifies character encoding."
        }
      ]
    },
    // ...existing code...
  };

  // Enhanced fallback logic with strict category filtering
  const getCategoryQuestions = (categoryTopic, difficultyLevel, requestedCategory) => {
    try {
      console.log(`🔍 Getting questions for: topic=${categoryTopic}, level=${difficultyLevel}, category=${requestedCategory}`);
      
      // First try exact match
      if (questionDB[categoryTopic] && questionDB[categoryTopic][difficultyLevel]) {
        return questionDB[categoryTopic][difficultyLevel];
      }
      
      // STRICT CATEGORY FILTERING - Only return questions from the requested category
      if (requestedCategory === 'JavaScript') {
        // Try different JavaScript topics at the same level
        const jsTopics = ['JavaScript Basics', 'Functions', 'Variables', 'ES6+ Features', 'DOM Manipulation', 'Event Handling', 'Async/Await'];
        
        for (const jsTopic of jsTopics) {
          if (questionDB[jsTopic] && questionDB[jsTopic][difficultyLevel]) {
            console.log(`✅ Found ${requestedCategory} questions in topic: ${jsTopic}`);
            return questionDB[jsTopic][difficultyLevel];
          }
        }
        
        // Fallback to beginner JavaScript if no level match
        for (const jsTopic of jsTopics) {
          if (questionDB[jsTopic] && questionDB[jsTopic]['beginner']) {
            console.log(`✅ Fallback to beginner ${requestedCategory} questions in topic: ${jsTopic}`);
            return questionDB[jsTopic]['beginner'];
          }
        }
        
        // Ultimate fallback - basic JavaScript questions
        console.log(`⚠️ Using ultimate JavaScript fallback`);
        return questionDB['JavaScript Basics']['beginner'] || [];
      } else if (requestedCategory === 'HTML') {
        // Add fallback logic for HTML
        const htmlTopics = ['HTML Basics'];
        for (const htmlTopic of htmlTopics) {
          if (questionDB[htmlTopic] && questionDB[htmlTopic][difficultyLevel]) {
            return questionDB[htmlTopic][difficultyLevel];
          }
        }
        // Fallback to beginner HTML
        for (const htmlTopic of htmlTopics) {
          if (questionDB[htmlTopic] && questionDB[htmlTopic]['beginner']) {
            return questionDB[htmlTopic]['beginner'];
          }
        }
        return [];
      }
      
      // For other categories, use existing logic but ensure category match
      const categoryDefaults = {
        'CSS': 'CSS Basics',
        'HTML': 'HTML Basics'
      };
      
      const category = Object.keys(categoryDefaults).find(cat => requestedCategory.includes(cat));
      if (category) {
        const defaultTopic = categoryDefaults[category];
        if (questionDB[defaultTopic] && questionDB[defaultTopic][difficultyLevel]) {
          return questionDB[defaultTopic][difficultyLevel];
        }
        
        if (questionDB[defaultTopic] && questionDB[defaultTopic]['beginner']) {
          return questionDB[defaultTopic]['beginner'];
        }
      }
      
      console.log(`❌ No questions found for category: ${requestedCategory}`);
      return [];
      
    } catch (error) {
      console.error('Error getting questions:', error);
      return [];
    }
  };
  
  return getCategoryQuestions(topic, level, category);
}

// API Endpoints

// Generate personalized quiz
app.get('/generate-quiz/:category', async (req, res) => {
  try {
    const category = req.params.category;
    const userEmail = req.query.email;
    const count = parseInt(req.query.count) || 10; // Default to 10 questions
    
    if (!userEmail) {
      return res.status(400).json({ error: 'User email is required for personalized quiz generation' });
    }

    console.log(`Generating unique quiz for user: ${userEmail}, category: ${category}, count: ${count}`);

    // Get or create user performance
    let userPerformance = await UserPerformance.findOne({ 
      email: userEmail,
      category: category 
    });

    if (!userPerformance) {
      userPerformance = new UserPerformance({
        email: userEmail,
        category: category,
        overallLevel: 'beginner',
        detailedProfile: {
          learningStyle: 'practical',
          preferredDifficulty: 'medium',
          attentionSpan: 60,
          commonMistakes: [],
          masteredConcepts: []
        }
      });
      await userPerformance.save();
    }

    // Update user level assessment
    await updateUserLevelAssessment(userEmail, category, userPerformance);

    // Generate unique questions
    const generatedQuestions = await AIQuestionGenerator.generateUniqueQuestions(
      userEmail, 
      category, 
      userPerformance, 
      count
    );

    // Format for frontend
    const questions = generatedQuestions.map(q => ({
      id: q._id,
      question: q.question,
      options: q.options,
      correctAnswer: q.correctAnswer,
      explanation: q.explanation,
      difficulty: q.difficulty,
      topic: q.topic
    }));

    // Personalization info
    const personalizationInfo = {
      userLevel: userPerformance.overallLevel,
      focusAreas: userPerformance.weakAreas,
      questionsGenerated: questions.length,
      learningStyle: userPerformance.detailedProfile.learningStyle,
      totalQuizzesTaken: userPerformance.quizzesTaken,
      uniquenessScore: await calculateUniquenessScore(userEmail, category)
    };

    res.json({
      questions,
      personalization: personalizationInfo,
      message: "Questions uniquely generated for your learning profile"
    });

  } catch (err) {
    console.error('Error generating personalized quiz:', err);
    res.status(500).json({ 
      error: 'Failed to generate personalized quiz',
      details: err.message 
    });
  }
});

// AI Quiz Generation endpoint
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const { category, email, count = 10 } = req.body; // Default to 10 questions
    
    console.log('Received quiz generation request:', { category, email, count });
    
    if (!category) {
      return res.status(400).json({ error: 'Category is required' });
    }

    // Get user performance
    let userPerformance = await UserPerformance.findOne({ email, category });
    
    if (!userPerformance) {
      userPerformance = new UserPerformance({
        email,
        category,
        overallLevel: 'beginner',
        detailedProfile: { learningStyle: 'practical' },
        weakAreas: [],
        strongAreas: [],
        skillMetrics: { accuracy: 0.5 }
      });
      await userPerformance.save();
    }

    console.log('📊 User profile:', {
      level: userPerformance.overallLevel,
      weakAreas: userPerformance.weakAreas,
      strongAreas: userPerformance.strongAreas
    });

    // Use Gemini for question generation
    const generatedQuestions = await AIQuestionGenerator.generateUniqueQuestions(
      email,
      category,
      userPerformance,
      count
    );

    if (!generatedQuestions.length) {
      console.error('❌ No questions generated successfully');
      return res.status(500).json({
        error: 'Failed to generate any questions with Gemini',
        details: 'All question generation attempts failed'
      });
    }

    const questions = generatedQuestions.map(q => ({
      id: q._id,
      question: q.question,
      options: q.options,
      correctAnswer: q.correctAnswer,
      explanation: q.explanation,
      difficulty: q.difficulty,
      topic: q.topic
    }));

    console.log(`🎉 Successfully generated ${questions.length}/${count} questions with Gemini`);

    res.json({
      questions,
      generatedBy: 'Gemini AI',
      totalGenerated: questions.length,
      requestedCount: count,
      success: true
    });

  } catch (err) {
    console.error('❌ Error in Gemini quiz generation:', err);
    res.status(500).json({
      error: 'Failed to generate quiz with Gemini',
      details: err.message,
      fallbackUsed: false
    });
  }
});

// Get topics for category
function getTopicsForCategory(category) {
  const categoryTopics = {
    'HTML': ['HTML Basics', 'HTML Elements', 'HTML Attributes', 'HTML Forms', 'HTML Tables', 'HTML5 Semantic Elements'],
    'CSS': ['CSS Basics', 'CSS Selectors', 'CSS Properties', 'CSS Layout', 'CSS Flexbox', 'CSS Grid'],
    'JavaScript': ['JavaScript Basics', 'Functions', 'Variables', 'ES6+ Features', 'DOM Manipulation', 'Event Handling', 'Async/Await']
  };
  return categoryTopics[category] || ['General Programming'];
}

// Dynamic AI Quiz Generation endpoint
app.post('/api/generate-dynamic-question', async (req, res) => {
  try {
    const { category, email, previousAnswers = [], questionNumber = 1, totalQuestions = 10 } = req.body;
    
    console.log('Generating dynamic question:', { 
      category, 
      email, 
      questionNumber, 
      previousAnswersCount: previousAnswers.length,
      previousAnswers: previousAnswers.map(a => ({ question: a.question.substring(0, 50), isCorrect: a.isCorrect, topic: a.topic }))
    });
    
    if (!category || !email) {
      return res.status(400).json({ error: 'Category and email are required' });
    }

    // Get user performance
    let userPerformance = await UserPerformance.findOne({ email, category });
    
    if (!userPerformance) {
      userPerformance = new UserPerformance({
        email,
        category,
        overallLevel: 'beginner',
        detailedProfile: { learningStyle: 'practical' },
        weakAreas: [],
        strongAreas: [],
        skillMetrics: { accuracy: 0.5 }
      });
      await userPerformance.save();
    }

    // Analyze previous answers to adapt difficulty and topics
    const adaptedProfile = await analyzeAndAdaptUserProfile(userPerformance, previousAnswers, category);
    
    console.log('Adapted profile:', adaptedProfile);
    
    // Generate single question with Hugging Face AI
    const question = await generateSingleAdaptiveQuestion(
      email, 
      category, 
      adaptedProfile, 
      questionNumber, 
      previousAnswers
    );

    if (!question) {
      console.error('Failed to generate question - trying fallback');
      return res.status(500).json({ error: 'Failed to generate question' });
    }

    console.log('Generated question successfully:', {
      id: question.id,
      questionPreview: question.question.substring(0, 50) + '...',
      topic: question.topic,
      difficulty: question.difficulty
    });

    res.json({ 
      question,
      adaptationInfo: {
        currentLevel: adaptedProfile.currentLevel,
        focusArea: adaptedProfile.focusArea,
        accuracyTrend: adaptedProfile.accuracyTrend,
        questionNumber,
        totalQuestions
      }
    });

  } catch (err) {
    console.error('Error generating dynamic question:', err);
    res.status(500).json({ 
      error: 'Failed to generate dynamic question',
      details: err.message 
    });
  }
});

// AI Question Generation endpoint - Add this missing endpoint
app.post('/api/generate-ai-question', async (req, res) => {
  try {
    const { 
      category, 
      email, 
      previousAnswers = [], 
      questionNumber = 1, 
      totalQuestions = 10,
      aiMode = 'enhanced',
      userProfile = {},
      aiPreferences = {}
    } = req.body;
    
    console.log('🎯 Enhanced AI question generation request:', {
      category, 
      email, 
      questionNumber, 
      aiMode,
      previousAnswersCount: previousAnswers.length
    });
    
    if (!category || !email) {
      return res.status(400).json({ error: 'Category and email are required' });
    }

    // Get user performance
    let userPerformance = await UserPerformance.findOne({ email, category });
    
    if (!userPerformance) {
      userPerformance = new UserPerformance({
        email,
        category,
        overallLevel: 'beginner',
        detailedProfile: { learningStyle: 'practical' },
        weakAreas: [],
        strongAreas: [],
        skillMetrics: { accuracy: 0.5 }
      });
      await userPerformance.save();
    }

    // Analyze and adapt user profile
    const adaptedProfile = await analyzeAndAdaptUserProfile(userPerformance, previousAnswers, category);
    
    console.log('🧠 Adapted user profile:', adaptedProfile);
    
    // Generate question with FAST AI or immediate fallback
    const question = await generateSingleAdaptiveQuestionFast(
      email, 
      category, 
      adaptedProfile, 
      questionNumber, 
      previousAnswers
    );

    if (!question) {
      throw new Error('Failed to generate question');
    }

    console.log('✅ Enhanced AI question generated:', {
      id: question.id,
      source: question.generatedBy,
      questionPreview: question.question.substring(0, 50) + '...'
    });

    res.json({ 
      question,
      adaptationInfo: {
        currentLevel: adaptedProfile.currentLevel,
        focusArea: adaptedProfile.focusArea,
        accuracyTrend: adaptedProfile.accuracyTrend,
        questionNumber,
        totalQuestions,
        aiEnhanced: true
      },
      aiModel: question._aiMetadata?.model || 'Intelligent-Fallback',
      generationTime: question._aiMetadata?.generationTime || 0,
      adaptedToUser: true,
      confidenceScore: 0.95
    });

  } catch (err) {
    console.error('❌ Error in AI question generation:', err);
    res.status(500).json({ 
      error: 'Failed to generate AI question',
      details: err.message 
    });
  }
});

// Enhanced coin reward system
const COIN_REWARDS = {
  QUIZ_COMPLETE: 25,        // Base coins for completing any quiz
  PERFECT_SCORE: 50,        // Bonus for perfect score
  PER_CORRECT_ANSWER: 5,    // Coins per correct answer
  FIRST_QUIZ_BONUS: 100,    // Bonus for first quiz ever
  DAILY_LOGIN: 50           // Daily login bonus
};

// Helper function to ensure user has engagement structure
async function ensureUserEngagement(email) {
  try {
    let user = await User.findOne({ email });
    if (!user) {
      console.log(`User not found: ${email}`);
      return null;
    }

    // Initialize engagement structure if missing
    if (!user.engagement) {
      user.engagement = {
        streak: { current: 0, longest: 0, lastActiveDate: null },
        coins: { balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, history: [] }
      };
      await user.save();
      console.log(`Initialized engagement for user: ${email}`);
    }

    return user;
  } catch (error) {
    console.error('Error ensuring user engagement:', error);
    return null;
  }
}

// Helper function to award coins
async function awardCoins(email, amount, action, meta = {}) {
  try {
    const user = await ensureUserEngagement(email);
    if (!user) return false;

    user.engagement.coins.balance += amount;
    user.engagement.coins.lifetimeEarned += amount;
    user.engagement.coins.history.push({
      action,
      amount,
      createdAt: new Date(),
      meta
    });

    await user.save();
    console.log(`Awarded ${amount} coins to ${email} for: ${action}`);
    return true;
  } catch (error) {
    console.error('Error awarding coins:', error);
    return false;
  }
}

// Quiz submission route - Enhanced to track AI questions
app.post('/submit-quiz', async (req, res) => {
  try {
    const { username, email, category, score, total, answers, timeSpent, questionIds, quizType } = req.body;
    
    console.log('📝 Submitting quiz:', { 
      username, 
      email, 
      category, 
      score, 
      total, 
      answersCount: answers?.length, 
      quizType,
      questionIds: questionIds?.length || 0
    });
    
    // Validate required fields
    if (!username || !email || !category || typeof score !== 'number' || typeof total !== 'number') {
      console.error('❌ Missing required fields:', { username, email, category, score, total });
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'username, email, category, score, and total are required'
      });
    }

    // Validate score range
    if (score < 0 || score > total || total <= 0) {
      console.error('❌ Invalid score values:', { score, total });
      return res.status(400).json({ 
        error: 'Invalid score values',
        details: 'Score must be between 0 and total, and total must be positive'
      });
    }
    
    // Determine if this was an AI-generated quiz
    let isAIGenerated = false;
    let generationSource = 'MANUAL';
    
    if (questionIds && questionIds.length > 0) {
      // Check if any questions were AI-generated
      const generatedQuestions = await GeneratedQuestion.find({
        _id: { $in: questionIds.filter(id => id) },
        generatedFor: email
      }).select('_id');
      
      if (generatedQuestions.length > 0) {
        isAIGenerated = true;
        // Get the most common generation source
        const sourceQuestions = await GeneratedQuestion.find({
          _id: { $in: questionIds.filter(id => id) }
        }).select('generatedBy');
        
        const sources = sourceQuestions.map(q => q.generatedBy).filter(Boolean);
        if (sources.includes('COHERE_API')) generationSource = 'COHERE_API';
        else if (sources.includes('PYTHON_COHERE')) generationSource = 'PYTHON_COHERE';
        else if (sources.includes('INTELLIGENT_FALLBACK')) generationSource = 'INTELLIGENT_FALLBACK';
      }
    }
    
    // Override with quizType if provided
    if (quizType === 'ai-powered') {
      isAIGenerated = true;
      if (generationSource === 'MANUAL') {
        generationSource = 'COHERE_API'; // Default for AI quizzes
      }
    }
    
    console.log('🤖 Quiz AI status:', { isAIGenerated, generationSource, quizType });
    
    // Save quiz result with AI tracking
    const result = new Result({
      username,
      email,
      category,
      score,
      total,
      submittedAt: new Date(),
      quizType: quizType || (isAIGenerated ? 'ai-powered' : 'standard'),
      aiGenerated: isAIGenerated,
      generationSource: generationSource,
      questionIds: questionIds || []
    });
    
    const savedResult = await result.save();
    console.log('💾 Quiz result saved:', savedResult._id);

    // Update generated questions with user responses
    if (questionIds && answers && Array.isArray(answers)) {
      try {
        const updatePromises = questionIds.map(async (questionId, index) => {
          if (questionId && answers[index]) {
            return await GeneratedQuestion.findByIdAndUpdate(questionId, {
              hasBeenUsed: true,
              userResponse: {
                wasCorrect: answers[index]?.isCorrect || false,
                timeSpent: answers[index]?.timeSpent || 0,
                submittedAt: new Date()
              }
            });
          }
        });
        
        await Promise.all(updatePromises);
        console.log('✅ Updated generated questions usage');
      } catch (updateError) {
        console.error('⚠️ Error updating question usage:', updateError);
        // Don't fail the entire submission for this
      }
    }

    // Get or create user performance record
    let userPerformance = await UserPerformance.findOne({ email, category });
    if (!userPerformance) {
      userPerformance = new UserPerformance({
        email,
        category,
        overallLevel: 'beginner',
        quizzesTaken: 0,
        skillMetrics: { accuracy: 0 },
        detailedProfile: {
          learningStyle: 'practical',
        },
        weakAreas: [],
        strongAreas: []
      });
    }

    // Update performance data
    userPerformance.quizzesTaken += 1;
    userPerformance.totalQuestions += total;
    userPerformance.correctAnswers += score;
    
    // Update weak and strong areas based on answers
    if (answers && Array.isArray(answers)) {
      const topicPerformance = {};
      
      answers.forEach(answer => {
        if (!answer.topic) return;
        
        if (!topicPerformance[answer.topic]) {
          topicPerformance[answer.topic] = {
            correct: 0,
            total: 0
          };
        }
        
        topicPerformance[answer.topic].total++;
        if (answer.isCorrect) {
          topicPerformance[answer.topic].correct++;
        }
      });
      
      // Update weak and strong areas
      Object.entries(topicPerformance).forEach(([topic, perf]) => {
        const accuracy = perf.correct / perf.total;
        
        // Remove from arrays first to avoid duplicates
        userPerformance.weakAreas = userPerformance.weakAreas.filter(t => t !== topic);
        userPerformance.strongAreas = userPerformance.strongAreas.filter(t => t !== topic);
        
        // Add to appropriate array
        if (accuracy < 0.6 && perf.total >= 2) {
          userPerformance.weakAreas.push(topic);
        } else if (accuracy > 0.8 && perf.total >= 2) {
          userPerformance.strongAreas.push(topic);
        }
      });
    }
    
    // Update skill metrics
    if (userPerformance.totalQuestions > 0) {
      userPerformance.skillMetrics.accuracy = userPerformance.correctAnswers / userPerformance.totalQuestions;
    }
    
    // Update user level assessment
    await updateUserLevelAssessment(email, category, userPerformance);
    await userPerformance.save();
    console.log('📊 User performance updated');
    
    // Award coins for quiz completion
    try {
      const user = await ensureUserEngagement(email);
      if (user) {
        let coins = COIN_REWARDS.QUIZ_COMPLETE;
        
        // Perfect score bonus
        if (score === total && total > 0) {
          coins += COIN_REWARDS.PERFECT_SCORE;
        }
        
        // Coins per correct answer
        coins += Math.max(0, Math.floor(score) * COIN_REWARDS.PER_CORRECT_ANSWER);
        
        // First quiz bonus
        if (userPerformance.quizzesTaken === 1) {
          coins += COIN_REWARDS.FIRST_QUIZ_BONUS;
        }
        
        await awardCoins(email, coins, `${category} Quiz Completion`, { score, total, category });
        console.log(`🪙 Awarded ${coins} coins for ${category} quiz completion`);
      }
    } catch (coinError) {
      console.error('⚠️ Coin award error:', coinError.message);
      // Don't fail quiz submission for coin errors
    }

    console.log('✅ Quiz submission completed successfully');
    
    const responseData = {
      success: true,
      message: 'Quiz submitted successfully',
      result: {
        id: savedResult._id,
        score,
        total,
        percentage: Math.round((score / total) * 100),
        aiGenerated: isAIGenerated,
        quizType: savedResult.quizType,
        category
      },
      userPerformance: {
        level: userPerformance.overallLevel,
        quizzesTaken: userPerformance.quizzesTaken,
        accuracy: Math.round(userPerformance.skillMetrics.accuracy * 100)
      }
    };
    
    res.json(responseData);
    
  } catch (err) {
    console.error('❌ Error submitting quiz:', err);
    res.status(500).json({ 
      error: 'Failed to submit quiz',
      details: err.message 
    });
  }
});

// Serve HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.use(express.static('public'));

// Signup route
app.post('/signup', async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).send('❌ Email already registered.');

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({ username, email, password: hashedPassword });
    await user.save();

    res.send('✅ Signup successful! You can now log in.');
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Error during signup.');
  }
});

// Login route
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Update daily streak and award coins
    const engagementUpdate = await updateDailyStreakOnLogin(email);

    // Return success response with engagement info
    return res.json({
      success: true,
      message: 'Login successful',
      user: {
        username: user.username,
        email: user.email
      },
      engagement: engagementUpdate
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper function to update daily streak and award coins
async function updateDailyStreakOnLogin(email) {
  const user = await User.findOne({ email });
  if (!user) return { success: false, error: 'User not found' };

  const today = new Date();
  const lastActiveDate = user.engagement?.streak?.lastActiveDate;

  // Initialize engagement fields if missing
  if (!user.engagement) {
    user.engagement = {
      streak: { current: 0, longest: 0, lastActiveDate: null },
      coins: { balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, history: [] }
    };
  }

  // Check if the user has already logged in today
  if (lastActiveDate && lastActiveDate.toDateString() === today.toDateString()) {
    return {
      success: true,
      alreadyUpdated: true,
      streak: user.engagement.streak,
      coins: user.engagement.coins
    };
  }

  // Update streak
  if (lastActiveDate && new Date(lastActiveDate).toDateString() === new Date(today.setDate(today.getDate() - 1)).toDateString()) {
    user.engagement.streak.current += 1; // Increment streak
  } else {
    user.engagement.streak.current = 1; // Reset streak
  }

  // Update longest streak
  if (user.engagement.streak.current > user.engagement.streak.longest) {
    user.engagement.streak.longest = user.engagement.streak.current;
  }

  // Update last active date
  user.engagement.streak.lastActiveDate = new Date();

  // Award daily login coins (50 coins per login)
  const dailyLoginCoins = 50;
  user.engagement.coins.balance += dailyLoginCoins;
  user.engagement.coins.lifetimeEarned += dailyLoginCoins;
  user.engagement.coins.history.push({
    action: 'Daily Login',
    amount: dailyLoginCoins,
    createdAt: new Date()
  });

  // Save the updated user
  await user.save();

  return {
    success: true,
    streak: user.engagement.streak,
    coins: user.engagement.coins
  };
}

// API to fetch engagement summary
app.get('/api/engagement/summary', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const streak = user.engagement?.streak || { current: 0, longest: 0 };
    const coins = user.engagement?.coins || { balance: 0 };

    res.json({ streak, coins });
  } catch (err) {
    console.error('Error fetching engagement summary:', err);
    res.status(500).json({ error: 'Failed to fetch engagement summary' });
  }
});

// ========== LEADERBOARD API ENDPOINTS ==========

// Get all unique quiz categories
app.get('/api/categories', async (_req, res) => {
  try {
    const categories = await Result.distinct('category');
    res.json(categories);
  } catch (err) {
    console.error('Error fetching categories:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get leaderboard data with filtering and pagination - ENHANCED VERSION
app.get('/api/leaderboard', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    console.log('Leaderboard request params:', req.query);
    
    // Build filter object
    const filter = {};
    
    // Category filter
    if (req.query.category && req.query.category !== 'all') {
      filter.category = req.query.category;
      console.log('Applied category filter:', filter.category);
    }
    
    // Quiz type filter
    if (req.query.quizType && req.query.quizType !== 'all') {
      if (req.query.quizType === 'ai-powered') {
        filter.aiGenerated = true;
        console.log('Applied AI filter: aiGenerated = true');
      } else if (req.query.quizType === 'standard') {
        filter.$or = [
          { aiGenerated: { $exists: false } },
          { aiGenerated: false },
          { aiGenerated: null }
        ];
        console.log('Applied standard filter: aiGenerated = false/null/undefined');
      }
    }
    
    // Time filter
    if (req.query.from) {
      const fromDate = new Date(req.query.from);
      filter.submittedAt = { $gte: fromDate };
      console.log('Applied time filter:', fromDate);
    }
    
    console.log('Final MongoDB filter:', JSON.stringify(filter, null, 2));
    
    // Get total count for pagination
    const total = await Result.countDocuments(filter);
    console.log('Total matching results:', total);
    
    // Enhanced aggregation to get top scores with AI info
    const results = await Result.aggregate([
      { $match: filter },
      { $sort: { score: -1, submittedAt: 1 } },
      { 
        $group: {
          _id: { email: "$email", category: "$category" },
          username: { $first: "$username" },
          email: { $first: "$email" },
          category: { $first: "$category" },
          score: { $max: "$score" },
          total: { $first: "$total" },
          submittedAt: { $first: "$submittedAt" },
          quizType: { $first: "$quizType" },
          aiGenerated: { $first: "$aiGenerated" },
          generationSource: { $first: "$generationSource" },
          totalQuizzes: { $sum: 1 },
          avgScore: { $avg: "$score" }
        }
      },
      { $sort: { score: -1, submittedAt: 1 } },
      { $skip: skip },
      { $limit: limit },
      { 
        $project: {
          _id: 0,
          username: 1,
          email: 1,
          category: 1,
          score: 1,
          total: 1,
          submittedAt: 1,
          quizType: 1,
          aiGenerated: 1,
          generationSource: 1,
          totalQuizzes: 1,
          avgScore: { $round: ["$avgScore", 1] },
          accuracy: { $round: [{ $multiply: [{ $divide: ["$score", "$total"] }, 100] }, 1] }
        }
      }
    ]);
    
    console.log(`Leaderboard results: ${results.length} entries found`);
    
    res.json({
      results,
      total,
      page,
           pages: Math.ceil(total / limit),
      filter: {
        category: req.query.category || 'all',
        quizType: req.query.quizType || 'all',
        from: req.query.from || null
      }
    });
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard data' });
  }
});

// New endpoint to get AI quiz statistics
app.get('/api/ai-quiz-stats', async (req, res) => {
  try {
    const stats = await Result.aggregate([
      {
        $group: {
          _id: null,
          totalQuizzes: { $sum: 1 },
          aiGeneratedQuizzes: { 
            $sum: { $cond: [{ $eq: ["$aiGenerated", true] }, 1, 0] } 
          },
          standardQuizzes: { 
            $sum: { $cond: [{ $ne: ["$aiGenerated", true] }, 1, 0] } 
          },
          cohereQuizzes: { 
            $sum: { $cond: [{ $eq: ["$generationSource", "COHERE_API"] }, 1, 0] } 
          },
          fallbackQuizzes: { 
            $sum: { $cond: [{ $eq: ["$generationSource", "INTELLIGENT_FALLBACK"] }, 1, 0] } 
          },
          avgAIScore: {
            $avg: {
              $cond: [{ $eq: ["$aiGenerated", true] }, "$score", null]
            }
          },
          avgStandardScore: {
            $avg: {
              $cond: [{ $ne: ["$aiGenerated", true] }, "$score", null]
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          totalQuizzes: 1,
          aiGeneratedQuizzes: 1,
          standardQuizzes: 1,
          cohereQuizzes: 1,
          fallbackQuizzes: 1,
          aiPercentage: { 
            $round: [
              { $multiply: [{ $divide: ["$aiGeneratedQuizzes", "$totalQuizzes"] }, 100] }, 
              1
            ] 
          },
          avgAIScore: { $round: ["$avgAIScore", 1] },
          avgStandardScore: { $round: ["$avgStandardScore", 1] }
        }
      }
    ]);
    
    res.json(stats[0] || {
      totalQuizzes: 0,
      aiGeneratedQuizzes: 0,
      standardQuizzes: 0,
      cohereQuizzes: 0,
      fallbackQuizzes: 0,
      aiPercentage: 0,
      avgAIScore: 0,
      avgStandardScore: 0
    });
  } catch (err) {
    console.error('Error fetching AI quiz stats:', err);
    res.status(500).json({ error: 'Failed to fetch AI quiz statistics' });
  }
});

// Enhanced user statistics with AI quiz breakdown
app.get('/api/users/:email/stats', async (req, res) => {
  try {
    const email = req.params.email;
    
    // Find all results for this user
    const userResults = await Result.find({ email });
    
    if (userResults.length === 0) {
      return res.json({
        rank: null,
        highScore: 0,
        quizzesTaken: 0,
        correctAnswers: 0,
        aiQuizzes: 0,
        standardQuizzes: 0,
        aiAccuracy: 0,
        standardAccuracy: 0
      });
    }
    
    // Calculate enhanced stats
    const quizzesTaken = userResults.length;
    const highScore = Math.max(...userResults.map(result => result.score));
    const correctAnswers = userResults.reduce((sum, result) => sum + result.score, 0);
    
    // AI vs Standard breakdown
    const aiQuizzes = userResults.filter(r => r.aiGenerated).length;
    const standardQuizzes = userResults.filter(r => !r.aiGenerated).length;
    
    const aiCorrect = userResults.filter(r => r.aiGenerated).reduce((sum, r) => sum + r.score, 0);
    const aiTotal = userResults.filter(r => r.aiGenerated).reduce((sum, r) => sum + r.total, 0);
    const aiAccuracy = aiTotal > 0 ? Math.round((aiCorrect / aiTotal) * 100) : 0;
    
    const standardCorrect = userResults.filter(r => !r.aiGenerated).reduce((sum, r) => sum + r.score, 0);
    const standardTotal = userResults.filter(r => !r.aiGenerated).reduce((sum, r) => sum + r.total, 0);
    const standardAccuracy = standardTotal > 0 ? Math.round((standardCorrect / standardTotal) * 100) : 0;
    
    res.json({
      rank: null,
      highScore,
      quizzesTaken,
      correctAnswers,
      aiQuizzes,
      standardQuizzes,
      aiAccuracy,
      standardAccuracy,
      overallAccuracy: Math.round((correctAnswers / userResults.reduce((sum, r) => sum + r.total, 0)) * 100)
    });
  } catch (err) {
    console.error('Error fetching user stats:', err);
    res.status(500).json({ error: 'Failed to fetch user statistics' });
  }
});

// Shop items (static for now, can be moved to a database later)
const shopItems = [
  { id: 1, name: 'Streak Freeze', description: 'Pause your streak for a day.', price: 50 },
  { id: 2, name: 'Quiz Hint', description: 'Get a hint for a quiz question.', price: 30 },
  { id: 3, name: 'Custom Avatar', description: 'Unlock a custom avatar.', price: 100 },
  { id: 4, name: 'Double Coins', description: 'Earn double coins for the next quiz.', price: 200 }
];

// API to fetch shop items
app.get('/api/shop/items', (req, res) => {
  res.json(shopItems);
});

// API to handle purchases
app.post('/api/shop/purchase', async (req, res) => {
  try {
    const { email, itemId } = req.body;

    if (!email || !itemId) {
      return res.status(400).json({ error: 'Email and itemId are required.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const item = shopItems.find(i => i.id === itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    if (user.engagement.coins.balance < item.price) {
      return res.status(400).json({ error: 'Insufficient coins.' });
    }

    // Deduct coins and add purchase to history
    user.engagement.coins.balance -= item.price;
    user.engagement.coins.lifetimeSpent += item.price;
    user.engagement.coins.history.push({
      action: `Purchased ${item.name}`,
      amount: -item.price,
      createdAt: new Date(),
      meta: { itemId: item.id, itemName: item.name }
    });

    await user.save();

    res.json({ success: true, balance: user.engagement.coins.balance, message: `You purchased ${item.name}!` });
  } catch (err) {
    console.error('Error processing purchase:', err);
    res.status(500).json({ error: 'Failed to process purchase.' });
  }
});

// Spin Wheel API endpoint
app.post('/api/shop/spin-wheel', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const spinCost = 50;
    if (user.engagement.coins.balance < spinCost) {
      return res.status(400).json({ error: 'Insufficient coins. You need 50 coins to spin.' });
    }

    // Deduct spin cost
    user.engagement.coins.balance -= spinCost;
    user.engagement.coins.lifetimeSpent += spinCost;

    // Define spin wheel prizes with probabilities
    const prizes = [
      { name: 'Small Reward', coins: 25, probability: 40 },
      { name: 'Medium Reward', coins: 75, probability: 30 },
      { name: 'Big Reward', coins: 150, probability: 20 },
      { name: 'Jackpot', coins: 300, probability: 8 },
      { name: 'Super Jackpot', coins: 500, probability: 2 }
    ];

    // Weighted random selection
    const random = Math.random() * 100;
    let cumulativeProbability = 0;
    let selectedPrize = prizes[0];

    for (const prize of prizes) {
      cumulativeProbability += prize.probability;
      if (random <= cumulativeProbability) {
        selectedPrize = prize;
        break;
      }
    }

    // Award the prize
    user.engagement.coins.balance += selectedPrize.coins;
    user.engagement.coins.lifetimeEarned += selectedPrize.coins;

    // Add to history
    user.engagement.coins.history.push({
      action: 'Spin Wheel Cost',
      amount: -spinCost,
      createdAt: new Date(),
      meta: { type: 'spin_cost' }
    });

    user.engagement.coins.history.push({
      action: `Spin Wheel Prize - ${selectedPrize.name}`,
      amount: selectedPrize.coins,
      createdAt: new Date(),
      meta: { 
        type: 'spin_prize',
        prize: selectedPrize.name,
        coins: selectedPrize.coins
      }
    });

    await user.save();

    res.json({ 
      success: true, 
      prize: selectedPrize.name,
      reward: selectedPrize.coins,
      balance: user.engagement.coins.balance,
      message: `Congratulations! You won ${selectedPrize.name}!`
    });

  } catch (err) {
    console.error('Error processing spin wheel:', err);
    res.status(500).json({ error: 'Failed to process spin wheel.' });
  }
});

// Helper functions for difficulty progression - moved to global scope
function getNextDifficultyLevel(currentLevel) {
  const levels = ['beginner', 'intermediate', 'advanced', 'expert'];
  const currentIndex = levels.indexOf(currentLevel);
  
  if (currentIndex < 0 || currentIndex >= levels.length - 1) {
    return currentLevel; // Stay at current level if it's invalid or already at maximum
  }
  
  return levels[currentIndex + 1]; // Return next level
}

function getPreviousDifficultyLevel(currentLevel) {
  const levels = ['beginner', 'intermediate', 'advanced', 'expert'];
  const currentIndex = levels.indexOf(currentLevel);
  return currentIndex > 0 ? levels[currentIndex - 1] : currentLevel;
}

function getAdvancedTopic(category, recentTopics) {
  const advancedTopics = {
    'HTML': ['HTML5 APIs', 'Web Components', 'Accessibility', 'Performance Optimization', 'Progressive Web Apps'],
    'CSS': ['CSS Grid Advanced', 'CSS Animations', 'CSS Variables', 'CSS Custom Properties', 'CSS Transforms', 'CSS Responsive Design'],
    'JavaScript': ['Async/Await', 'Closures', 'Prototypes', 'ES6+ Features', 'Event Loop', 'Module Systems', 'Web APIs']
  };
  
  const categoryTopics = advancedTopics[category] || advancedTopics['JavaScript'];
  const unusedTopics = categoryTopics.filter(topic => !recentTopics.includes(topic));
  
  return unusedTopics.length > 0 ? 
    unusedTopics[Math.floor(Math.random() * unusedTopics.length)] : 
    categoryTopics[Math.floor(Math.random() * categoryTopics.length)];
}

// Add the missing analyzeAndAdaptUserProfile function
async function analyzeAndAdaptUserProfile(userPerformance, previousAnswers, category) {
  let currentLevel = userPerformance.overallLevel;
  let focusArea = getCategoryDefaults(category).defaultTopic;
  let accuracyTrend = 'stable';
  
  console.log(`Analyzing user profile for ${category} with`, previousAnswers.length, 'previous answers');
  
  try {
    if (previousAnswers.length > 0) {
      const correctAnswers = previousAnswers.filter(a => a.isCorrect).length;
      const sessionAccuracy = correctAnswers / previousAnswers.length;
      
      console.log(`${category} session accuracy:`, sessionAccuracy);
      
      const topicPerformance = {};
      const recentTopics = [];
      
      previousAnswers.forEach(answer => {
        const topic = answer.topic || getCategoryDefaults(category).defaultTopic;
        recentTopics.push(topic);
        
        if (!topicPerformance[topic]) {
          topicPerformance[topic] = { correct: 0, total: 0 };
        }
        topicPerformance[topic].total++;
        if (answer.isCorrect) {
          topicPerformance[topic].correct++;
        }
      });

      const weakTopics = Object.entries(topicPerformance)
        .filter(([topic, perf]) => perf.total >= 2 && (perf.correct / perf.total) < 0.5)
        .map(([topic]) => topic);

      // Adaptive difficulty adjustment
      if (sessionAccuracy >= 0.8 && previousAnswers.length >= 3) {
        currentLevel = getNextDifficultyLevel(currentLevel);
        accuracyTrend = 'improving';
      } else if (sessionAccuracy <= 0.4 && previousAnswers.length >= 3) {
        currentLevel = getPreviousDifficultyLevel(currentLevel);
        accuracyTrend = 'struggling';
      }

      // Enhanced focus area selection
      if (weakTopics.length > 0) {
        focusArea = weakTopics[Math.floor(Math.random() * weakTopics.length)];
      } else if (sessionAccuracy > 0.7 && previousAnswers.length >= 4) {
        focusArea = getAdvancedTopic(category, recentTopics);
      } else if (previousAnswers.length < 3) {
        const basicTopics = category === 'JavaScript' ? 
          ['JavaScript Basics', 'Functions', 'Variables'] :
          category === 'CSS' ? 
          ['CSS Basics', 'CSS Selectors', 'CSS Properties'] :
          ['HTML Basics', 'HTML Elements', 'HTML Attributes'];
        focusArea = basicTopics[Math.floor(Math.random() * basicTopics.length)];
      } else {
        const intermediateTopics = category === 'JavaScript' ?
          ['ES6+ Features', 'DOM Manipulation', 'Event Handling', 'Async/Await'] :
          category === 'CSS' ?
          ['CSS Layout', 'CSS Flexbox', 'CSS Grid', 'CSS Animations'] :
          ['HTML Forms', 'HTML Tables', 'HTML5 Semantic Elements', 'HTML Document Structure'];
        focusArea = intermediateTopics[Math.floor(Math.random() * intermediateTopics.length)];
      }
    }
  } catch (analysisError) {
    console.error(`Error in ${category} profile analysis:`, analysisError);
    currentLevel = userPerformance.overallLevel || 'beginner';
    focusArea = getCategoryDefaults(category).defaultTopic;
    accuracyTrend = 'stable';
  }

  return {
    currentLevel,
    focusArea,
    accuracyTrend,
    learningStyle: userPerformance.detailedProfile?.learningStyle || 'practical',
    weakAreas: userPerformance.weakAreas || [],
    strongAreas: userPerformance.strongAreas || []
  };
}

// Add category defaults function
function getCategoryDefaults(category) {
  const defaults = {
    'HTML': { defaultTopic: 'HTML Basics' },
    'CSS': { defaultTopic: 'CSS Basics' },
    'JavaScript': { defaultTopic: 'JavaScript Basics' }
  };
  return defaults[category] || { defaultTopic: 'General Programming' };
}

// Update the generateSingleAdaptiveQuestionFast function to handle all categories
async function generateSingleAdaptiveQuestionFast(email, category, adaptedProfile, questionNumber, previousAnswers) {
  console.log(`⚡ FAST AI question generation with Gemini for ${category}...`);
  try {
    const startTime = Date.now();

    // Try Gemini API directly first
    if (GEMINI_API_KEY && GEMINI_API_KEY.length > 10) {
      console.log(`🤖 Attempting direct Gemini API generation for ${category}...`);
      try {
        const prompt = `Generate a ${category} quiz question for ${adaptedProfile.currentLevel} level about ${adaptedProfile.focusArea || getCategoryDefaults(category).defaultTopic}.

Return ONLY valid JSON in this exact format:
{
  "question": "Your question text here",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctAnswer": "Option A",
  "explanation": "Explanation of why this answer is correct"
}

Make sure the question is educational and the correct answer is one of the four options.`;

        const aiResponse = await callGeminiAPI(prompt);

        // Clean and parse the response
        let jsonText = aiResponse.trim();
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
        }

        const questionData = JSON.parse(jsonText);

        // Validate the question structure
        if (!questionData.question || !questionData.options || !Array.isArray(questionData.options) || questionData.options.length !== 4) {
          throw new Error(`Invalid ${category} question structure from Gemini`);
        }

        if (!questionData.correctAnswer || !questionData.options.includes(questionData.correctAnswer)) {
          throw new Error(`${category} correct answer not found in options`);
        }

        console.log(`✅ Gemini API ${category} question generated successfully`);

        // Save to database
        const generatedQuestion = new GeneratedQuestion({
          category,
          question: questionData.question,
          options: questionData.options,
          correctAnswer: questionData.correctAnswer,
          difficulty: adaptedProfile.currentLevel,
          topic: adaptedProfile.focusArea || getCategoryDefaults(category).defaultTopic,
          explanation: questionData.explanation || `Gemini generated ${category} explanation`,
          generatedFor: email,
          createdAt: new Date()
        });

        const saved = await generatedQuestion.save();

        return {
          id: saved._id,
          question: questionData.question,
          options: questionData.options,
          correctAnswer: questionData.correctAnswer,
          difficulty: adaptedProfile.currentLevel,
          topic: adaptedProfile.focusArea || getCategoryDefaults(category).defaultTopic,
          explanation: questionData.explanation,
          generatedBy: 'GEMINI_API',
          _aiMetadata: {
            model: 'gemini-pro',
            generationTime: Date.now() - startTime,
            source: 'DIRECT_GEMINI'
          }
        };

      } catch (geminiError) {
        console.log(`❌ Direct Gemini API failed for ${category}:`, geminiError.message);
      }
    }

  } catch (error) {
    console.log(`❌ All AI attempts failed for ${category}, using intelligent fallback:`, error.message);
  }

  // IMMEDIATE INTELLIGENT FALLBACK
  console.log(`🎯 Using FAST intelligent fallback for ${category}...`);
  return await generateIntelligentFallbackQuestion(email, category, adaptedProfile, questionNumber);
}

// AI Status and Test Endpoints

// Add new AI status endpoint with better testing
app.get('/api/ai-status', async (req, res) => {
  try {
    console.log('🔍 Checking Gemini AI system status...');
    const hasGeminiKey = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 10;
    let geminiAvailable = false;
    let primaryAI = 'FALLBACK';

    if (hasGeminiKey) {
      try {
        // Simple test prompt for Gemini
        const testPrompt = 'Generate a simple quiz question in JSON format.';
        const testResponse = await callGeminiAPI(testPrompt);
        if (testResponse) {
          geminiAvailable = true;
          primaryAI = 'GEMINI';
          console.log('✅ Gemini AI operational!');
        }
      } catch (error) {
        console.log('❌ Gemini status check failed:', error.message);
      }
    }

    res.json({
      geminiAvailable,
      geminiKeyConfigured: hasGeminiKey,
      primaryAI,
      status: geminiAvailable ? 'GEMINI_OPERATIONAL' : 'FALLBACK_READY',
      apiVersion: 'gemini-pro'
    });

  } catch (error) {
    console.error('Gemini AI status check error:', error);
    res.json({
      geminiAvailable: false,
      geminiKeyConfigured: false,
      primaryAI: 'FALLBACK',
      status: 'ERROR',
      apiVersion: 'unknown'
    });
  }
});

app.get('/api/test-gemini', async (req, res) => {
  try {
    console.log('🧪 Testing Gemini AI...');
    if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 10) {
      return res.json({
        status: 'FAILED',
        error: 'No valid Gemini API key found',
        hasKey: false
      });
    }

    const startTime = Date.now();
    try {
      const testPrompt = `Generate a simple quiz question. Return ONLY valid JSON:
{
  "question": "What does HTML stand for?",
  "options": ["Hyper Text Markup Language", "High Tech Modern Language", "Home Tool Markup Language", "Hyperlink Text Modern Language"],
  "correctAnswer": "Hyper Text Markup Language",
  "explanation": "HTML stands for Hyper Text Markup Language."
}`;
      const response = await callGeminiAPI(testPrompt);
      const responseTime = Date.now() - startTime;

      let jsonText = response.trim();
      jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }

      const parsedResponse = JSON.parse(jsonText);

      return res.json({
        status: 'SUCCESS',
        message: 'Gemini AI is working perfectly!',
        response: parsedResponse,
        hasKey: true,
        keyLength: GEMINI_API_KEY.length,
        responseTime: responseTime,
        apiVersion: 'gemini-pro'
      });

    } catch (testError) {
      const responseTime = Date.now() - startTime;
      return res.json({
        status: 'FAILED',
        error: testError.message,
        hasKey: true,
        keyLength: GEMINI_API_KEY.length,
        responseTime: responseTime,
        apiVersion: 'gemini-pro'
      });
    }

  } catch (error) {
    console.error('❌ Gemini test error:', error);
    return res.json({
      status: 'ERROR',
      error: error.message,
      hasKey: !!GEMINI_API_KEY,
      apiVersion: 'gemini-pro'
    });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});