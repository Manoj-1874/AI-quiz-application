import cohere
import json
import sys
import argparse
import os

usage_file = "usage_count.txt"

# Read existing usage count from file
if os.path.exists(usage_file):
    with open(usage_file, "r") as f:
        usage_count = int(f.read().strip() or 0)
else:
    usage_count = 0

def log_api_usage():
    global usage_count
    usage_count += 1
    with open(usage_file, "w") as f:
        f.write(str(usage_count))

API_KEY = "nniQXVUQMSnHgRK4cXH8Xi8TV3GMGSmVZLWrg7IH"
co = cohere.Client(API_KEY)

def generate_questions(topic="HTML Basics", difficulty="beginner", num_questions=1):
    prompt = f"""
You are an adaptive quiz generator.
Topic: {topic}
Difficulty: {difficulty}
Generate {num_questions} multiple-choice questions in JSON format:
[
  {{
    "question": "string",
    "choices": ["A", "B", "C", "D"],
    "answer_index": 0,
    "explanation": "string"
  }}
]
Ensure the JSON is valid and nothing else is returned.
"""

    try:
        response = co.chat(
            model="command-r",
            message=prompt,
            temperature=0.7,
            max_tokens=800
        )

        # Parse JSON from response
        questions = json.loads(response.text)
        return questions
    except json.JSONDecodeError as e:
        print(f"Error parsing JSON from Cohere output: {e}", file=sys.stderr)
        print(f"Raw response: {response.text}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"Error calling Cohere API: {e}", file=sys.stderr)
        return []

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Generate quiz questions with Cohere')
    parser.add_argument('--topic', default='HTML Basics', help='Topic for questions')
    parser.add_argument('--difficulty', default='beginner', help='Difficulty level')
    parser.add_argument('--count', type=int, default=1, help='Number of questions')
    parser.add_argument('--mode', choices=['json', 'interactive'], default='json',
                        help='Output mode: json for API, interactive for terminal quiz')
    
    args = parser.parse_args()
    
    if args.mode == "json":
        # JSON output for Node.js integration
        questions = generate_questions(args.topic, args.difficulty, args.count)
        print(json.dumps(questions))
    else:
        # Interactive mode for testing
        questions = generate_questions(args.topic, args.difficulty, args.count)
        
        if not questions:
            print("No questions generated.")
            sys.exit(1)
        
        for i, q in enumerate(questions, start=1):
            print(f"\nQ{i}: {q['question']}")
            for idx, choice in enumerate(q['choices']):
                print(f"  {idx}. {choice}")
            
            try:
                user_input = int(input("Your answer (0-3): "))
                if 0 <= user_input <= 3:
                    correct = (user_input == q['answer_index'])
                    correct_answer = q['choices'][q['answer_index']]
                    print("✅ Correct!" if correct else f"❌ Wrong. Correct answer: {correct_answer}")
                    if 'explanation' in q:
                        print(f"Explanation: {q['explanation']}")
                else:
                    print("Invalid input. Please enter 0-3.")
            except (ValueError, KeyboardInterrupt):
                print("\nQuiz interrupted.")
                break
            for idx, choice in enumerate(q['choices']):
                print(f"  {idx}. {choice}")
            
            try:
                user_input = int(input("Your answer (0-3): "))
            except ValueError:
                print("Invalid input.")
                continue
            
            correct = (user_input == q['answer_index'])
            print("✅ Correct!" if correct else f"❌ Wrong. Correct answer: {q['choices'][q['answer_index']]}")
            print(f"Explanation: {q['explanation']}")
            
            ability_score = update_ability(ability_score, correct)
